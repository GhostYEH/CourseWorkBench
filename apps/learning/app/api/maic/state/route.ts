/**
 * 课堂受控状态（播放位置）。
 *
 * SQLite 是唯一权威：浏览器缓存不能决定课堂回到哪个场景，因此读写都走这里，
 * 重启后由服务恢复。这里只读已落库的课件，不在状态接口里写权威知识或题目——
 * 课堂不能因为有人打开页面就成为知识写入者。
 */

import { z } from 'zod';
import { StudyError, projectScopeSchema, type ClassroomSceneBinding } from '@sew/study-contracts';
import { parseBody, parseQuery, route, ok } from '../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../lib/server/service';
import { loadRenderableDocument } from '../../../../lib/server/classroom-service';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ stageId: z.string().min(1) });
const stateBodySchema = z.object({
  scope: projectScopeSchema,
  stageId: z.string().min(1),
  sceneId: z.string().min(1),
});

export const GET = route((request: Request) => {
  const session = requireSession();
  const { stageId } = parseQuery(request, querySchema);
  const stored = loadRenderableDocument(session, stageId);
  if (!stored) throw new StudyError('NOT_FOUND', { stageId });

  const sceneTypes = new Map<string, string>(
    ((stored.document as { scenes?: Array<Record<string, unknown>> }).scenes ?? []).map((scene) => [
      String(scene['id'] ?? ''),
      String(scene['type'] ?? ''),
    ]),
  );
  const SCENE_TYPES = ['slide', 'quiz', 'interactive', 'pbl'] as const;
  const bindings: ClassroomSceneBinding[] = [...session.store
    .listClassroomSceneSources(session.projectId, stageId)
    .values()]
    .map((row) => ({ row, sceneType: sceneTypes.get(row.sceneId) }))
    // 场景类型不在合同枚举内时不返回该绑定，而不是发一个非法 DTO。
    .filter(
      (item): item is { row: typeof item.row; sceneType: (typeof SCENE_TYPES)[number] } =>
        (SCENE_TYPES as readonly unknown[]).includes(item.sceneType),
    )
    .map(({ row, sceneType }) => ({
      sceneId: row.sceneId,
      sceneType,
      knowledgeIds: row.knowledgeIds,
      questionId: row.questionId,
      reviewedBy: row.reviewedBy,
      reviewNote: row.reviewNote,
    }))
    .filter((binding) => binding.knowledgeIds.length > 0 && binding.reviewedBy.length > 0);

  const state = session.store.readClassroomState(session.projectId, stageId);
  return ok({
    stageId,
    currentSceneId: state?.currentSceneId ?? '',
    revision: state?.revision ?? 0,
    bindings,
  });
});

/** 写入播放位置：代次复验后只接受该文档里真实存在的场景，幂等覆盖。 */
export const PUT = route(async (request: Request) => {
  const body = await parseBody(request, stateBodySchema);
  const session = assertScope(body.scope);
  if (!loadRenderableDocument(session, body.stageId)) {
    throw new StudyError('NOT_FOUND', { stageId: body.stageId });
  }
  const state = session.store.writeClassroomState(session.projectId, body.stageId, body.sceneId);
  if (!state) {
    throw new StudyError('INVALID_ARGUMENT', {
      reason: 'scene_not_in_document',
      stageId: body.stageId,
      sceneId: body.sceneId,
    });
  }
  return ok({ stageId: state.stageId, currentSceneId: state.currentSceneId, revision: state.revision });
});
