/**
 * OpenMAIC DocumentStore 的 HTTP 合同实现（CLASS-01）。
 *
 * 路径、方法与错误码沿用上游：客户端 `HttpDocumentStore` 与参考服务端
 * `@openmaic/storage/server/document.ts`（`VALIDATION_FAILED`、`PAYLOAD_TOO_LARGE`、
 * `ROUTE_NOT_FOUND`、`NOT_JSON_SAFE`、`DOCUMENT_NOT_FOUND`、`SCENE_NOT_FOUND`、
 * 409 `FUTURE_VERSION`，写入成功回 204）。
 * 本项目只增加一个自有码：`CLASSROOM_LESSON_NOT_REVIEWED`（403）——上游没有
 * 「未审核内容不能写入」这一约束。
 *
 * 与本项目其它接口不同，这里返回**合同原始载荷**而不是 `{ ok, data }` 信封，
 * 否则真实上游客户端无法解析。
 *
 * 权威边界：
 * - SQLite 按当前打开项目分区，请求不能在路径里指定项目；
 * - 写入只接受与仓库内登记课件完全一致（同指纹）的文档或场景；
 * - 读取时再复验一次指纹，并去掉测验判分答案。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DSL_VERSION, validateScene, validateStage } from '@openmaic/dsl';
import { StudyError } from '@sew/study-contracts';
import { classroomDocumentDigest, dslVersionState } from '@sew/study-domain';
import { decodeJson } from '@sew/study-storage';
import { mapHttpError, sanitizePublicValue } from '../../../../../lib/server/http';
import { scopedRequest } from '../../../../../lib/server/scoped-request';
import { readBoundedBody } from '../../../../../lib/server/bounded-body';
import { assertScope, type Session } from '../../../../../lib/server/service';
import {
  REVIEWED_DOCUMENT_DIGEST,
  assertReviewedDocumentWrite,
  loadRenderableDocument,
  reviewedLesson,
  reviewedSceneDigest,
} from '../../../../../lib/server/classroom-service';

export const dynamic = 'force-dynamic';

/** 与上游参考服务同量级的请求体上限（32 MiB），先按 Content-Length 拦截。 */
const MAX_DOCUMENT_BODY_BYTES = 32 * 1024 * 1024;
interface Context {
  params: Promise<{ segments?: string[] }>;
}

const contractError = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): NextResponse => {
  const safeMessage = sanitizePublicValue(message) as string;
  const safeDetails = details === undefined ? undefined : sanitizePublicValue(details) as Record<string, unknown>;
  return NextResponse.json({ error: { code, message: safeMessage, ...(safeDetails ? { details: safeDetails } : {}) } }, { status });
};

const routeNotFound = (): NextResponse =>
  contractError(404, 'ROUTE_NOT_FOUND', 'route not found');

const validationFailed = (
  message: string,
  details: Record<string, unknown>,
): NextResponse => contractError(400, 'VALIDATION_FAILED', message, details);

const notFound = (kind: 'DOCUMENT_NOT_FOUND', stageId: string): NextResponse =>
  contractError(404, kind, '课堂文档不存在', { stageId });

const sceneNotFound = (stageId: string, sceneId: string): NextResponse =>
  contractError(404, 'SCENE_NOT_FOUND', '场景不存在', { stageId, sceneId });

const notReviewed = (details: Record<string, unknown>): NextResponse =>
  contractError(403, 'CLASSROOM_LESSON_NOT_REVIEWED', '内容不是已登记的审核课件', details);

/** 未来 DSL 版本必须显式拒绝，不能让旧应用猜测新形状。 */
const refuseFutureVersion = (document: unknown): NextResponse | null => {
  const declared = (document as { dslVersion?: unknown }).dslVersion;
  if (dslVersionState(declared, DSL_VERSION) !== 'future') return null;
  return contractError(409, 'FUTURE_VERSION', '文档声明的 DSL 版本高于当前应用支持版本', {
    storedVersion: typeof declared === 'string' ? declared : String(declared),
    supportedVersion: DSL_VERSION,
  });
};

const parseJsonBody = async (request: Request): Promise<unknown> => {
  const bytes = await readBoundedBody(request, MAX_DOCUMENT_BODY_BYTES, reason =>
    new StudyError('INVALID_ARGUMENT', reason === 'too_large'
      ? { reason: 'payload_too_large', limit: MAX_DOCUMENT_BODY_BYTES }
      : { reason: reason === 'missing' ? 'empty_body' : 'unreadable_body' }));
  const text = new TextDecoder().decode(bytes);
  // JSON 解析集中在 json-codec：这里只接受任意合法 JSON，形状稍后由 DSL 校验器裁定。
  const decoded = decodeJson<unknown>(text, z.unknown(), null, 'maic-document-body');
  if (!decoded.ok) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'invalid_json', error: decoded.error });
  }
  return decoded.value;
};

const noContent = (): NextResponse => new NextResponse(null, { status: 204 });

const scenesOf = (document: unknown): unknown[] =>
  Array.isArray((document as { scenes?: unknown }).scenes)
    ? ((document as { scenes: unknown[] }).scenes)
    : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const scopedSession = (request: Request): {
  scope: { projectId: string; generation: number }; session: Session;
} => scopedRequest(request, requiredHeaders => new StudyError('INVALID_ARGUMENT',
  { requiredHeaders }, '缺少有效的课堂项目范围'));

const docRoute = <Args extends unknown[]>(handler: (...args: Args) => Promise<NextResponse> | NextResponse) =>
  async (...args: Args): Promise<NextResponse> => {
    try {
      return await handler(...args);
    } catch (error) {
      // Reuse the public HTTP boundary's sanitization and cross-package error mapping,
      // then restore the upstream DocumentStore's raw { error } contract.
      const mapped = mapHttpError(error);
      const payload = mapped;
      let code: string = payload.error.code;
      let status = mapped.status;
      // The shared application boundary calls these INVALID_ARGUMENT; the upstream
      // DocumentStore contract uses VALIDATION_FAILED / PAYLOAD_TOO_LARGE.
      if (code === 'INVALID_ARGUMENT') {
        if (payload.error?.details?.reason === 'payload_too_large') {
          code = 'PAYLOAD_TOO_LARGE';
          status = 413;
        } else {
          code = 'VALIDATION_FAILED';
          status = 400;
        }
      }
      return contractError(
        status,
        code,
        payload.error?.message ?? '课堂文档请求失败',
        payload.error?.details,
      );
    }
  };

const requireSessionScope = (request: Request): ReturnType<typeof scopedSession> => scopedSession(request);

export const GET = docRoute(async (request: Request, context: Context) => {
  const path = (await context.params).segments ?? [];
  const scoped = requireSessionScope(request);
  if (scoped instanceof NextResponse) return scoped;
  const { session } = scoped;

  if (path.length === 0) {
    const folderIds = session.store.listClassroomDocumentFolderIds(session.projectId);
    return NextResponse.json(
      session.store.listClassroomDocuments(session.projectId).map((row) => ({
        id: row.stageId,
        name: row.name,
        ...(row.description.length > 0 ? { description: row.description } : {}),
        createdAt: Number.isNaN(Date.parse(row.createdAt)) ? 0 : Date.parse(row.createdAt),
        updatedAt: Number.isNaN(Date.parse(row.updatedAt)) ? 0 : Date.parse(row.updatedAt),
        sceneCount: row.sceneCount,
        ...(folderIds.has(row.stageId) ? { folderId: folderIds.get(row.stageId) } : {}),
      })),
    );
  }

  const [stageId, sub, sceneId] = path;
  const renderable = loadRenderableDocument(session, stageId ?? '');
  if (!renderable) return notFound('DOCUMENT_NOT_FOUND', stageId ?? '');

  if (path.length === 1) return NextResponse.json(renderable.document);

  if (path.length === 2 && sub === 'stage') {
    return NextResponse.json((renderable.document as { stage: unknown }).stage);
  }

  if (path.length === 3 && sub === 'scenes') {
    const scene = scenesOf(renderable.document).find((item) => (item as { id?: unknown }).id === sceneId);
    if (!scene) return sceneNotFound(stageId ?? '', sceneId ?? '');
    const check = validateScene(scene);
    if (!check.valid) {
      return contractError(500, 'NOT_JSON_SAFE', '存储的场景不符合课堂合同', { errors: check.errors });
    }
    return NextResponse.json(scene);
  }

  return routeNotFound();
});

export const PUT = docRoute(async (request: Request, context: Context) => {
  const path = (await context.params).segments ?? [];
  const body = await parseJsonBody(request);
  if (!isRecord(body)) return validationFailed('请求体必须是 JSON 对象', { expected: 'object' });
  const scoped = requireSessionScope(request);
  if (scoped instanceof NextResponse) return scoped;
  const { scope, session } = scoped;
  const futureRefusal = refuseFutureVersion(body);
  if (futureRefusal) return futureRefusal;

  const [stageId, sub, sceneId] = path;

  if (path.length === 1) {
    if (stageId !== reviewedLesson.stageId) {
      return notReviewed({ reason: 'unknown_stage', stageId, expectedStageId: reviewedLesson.stageId });
    }
    const stageCheck = validateStage((body as { stage?: unknown }).stage);
    if (!stageCheck.valid) {
      return validationFailed('文档不符合 DSL Stage 合同', { errors: stageCheck.errors });
    }
    for (const scene of scenesOf(body)) {
      const sceneCheck = validateScene(scene);
      if (!sceneCheck.valid) {
        return validationFailed('文档不符合 DSL Scene 合同', {
          sceneId: String(isRecord(scene) ? scene.id ?? '' : ''),
          errors: sceneCheck.errors,
        });
      }
    }
    const bodyStageId = (body.stage as { id?: unknown }).id;
    if (bodyStageId !== stageId || scenesOf(body).some((scene) =>
      !isRecord(scene) || scene.stageId !== stageId || typeof scene.id !== 'string')) {
      return validationFailed('文档路径与文档内部身份不一致', { stageId, documentStageId: bodyStageId });
    }
    // 指纹守卫在前；来源绑定只能由服务端经真实审核链派生。
    assertReviewedDocumentWrite(body);
    if (!loadRenderableDocument(session, stageId)) return notFound('DOCUMENT_NOT_FOUND', stageId);
    assertScope(scope);
    return noContent();
  }

  if (path.length === 2 && sub === 'stage') {
    if (!isRecord(body) || body.id !== stageId) {
      return validationFailed('Stage 路径与 stage.id 不一致', { stageId, documentStageId: isRecord(body) ? body.id : null });
    }
    const existing = loadRenderableDocument(session, stageId ?? '');
    if (!existing) return notFound('DOCUMENT_NOT_FOUND', stageId ?? '');
    if (existing.stageId !== stageId) return notFound('DOCUMENT_NOT_FOUND', stageId ?? '');
    if (classroomDocumentDigest(body) !== classroomDocumentDigest(reviewedLesson.document.stage)) {
      return notReviewed({ reason: 'stage_not_reviewed', stageId });
    }
    assertScope(scope);
    return noContent();
  }

  if (path.length === 3 && sub === 'scenes') {
    if (!isRecord(body) || body.id !== sceneId || body.stageId !== stageId) {
      return validationFailed('Scene 路径与场景身份不一致', {
        stageId, sceneId, documentStageId: isRecord(body) ? body.stageId : null,
        documentSceneId: isRecord(body) ? body.id : null,
      });
    }
    const existing = loadRenderableDocument(session, stageId ?? '');
    if (!existing) return notFound('DOCUMENT_NOT_FOUND', stageId ?? '');
    const expected = reviewedSceneDigest(sceneId ?? '');
    if (expected === null) return notReviewed({ reason: 'scene_not_registered', sceneId });
    if (classroomDocumentDigest(body) !== expected) {
      return notReviewed({ reason: 'scene_digest_mismatch', sceneId });
    }
    const writeSession = assertScope(scope);
    const written = writeSession.store.putClassroomScene(
      writeSession.projectId,
      stageId ?? '',
      body,
      REVIEWED_DOCUMENT_DIGEST,
    );
    if (!written) return notFound('DOCUMENT_NOT_FOUND', stageId ?? '');
    // 场景写回后整份文档必须仍等于登记指纹并可正常读取，否则不承认这次写入。
    const verified = loadRenderableDocument(session, stageId ?? '');
    if (!verified || verified.sceneCount !== reviewedLesson.document.scenes.length) {
      return contractError(500, 'NOT_JSON_SAFE', '场景写入后文档与登记课件不一致', { sceneId });
    }
    return noContent();
  }

  return routeNotFound();
});

export const DELETE = docRoute(async (request: Request, context: Context) => {
  const path = (await context.params).segments ?? [];
  const scoped = requireSessionScope(request);
  if (scoped instanceof NextResponse) return scoped;
  const { scope, session } = scoped;

  if (path.length === 1) {
    const existing = session.store.getClassroomDocument(session.projectId, path[0] ?? '');
    if (!existing) return notFound('DOCUMENT_NOT_FOUND', path[0] ?? '');
    const writeSession = assertScope(scope);
    writeSession.store.deleteClassroomDocument(writeSession.projectId, existing.stageId);
    return noContent();
  }

  if (path.length === 3 && path[1] === 'scenes') {
    // 固定审核课件在 M0 不可编辑：删除单个场景会让落库文档偏离已登记内容。
    return contractError(403, 'ROLE_PERMISSION_DENIED', '已登记课件的场景不能在课堂内删除', {
      sceneId: path[2],
    });
  }

  return routeNotFound();
});
