import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  StudyError, newId, learnerUidSchema, classroomRoomSchema, classroomSharedCourseSchema,
  LEGACY_LOCAL_LEARNER_KEY,
  classroomTeacherLeaseSchema, classroomRoomMemberSchema,
  type ClassroomRoomDto, type ClassroomSharedCourseDto, type ClassroomTeacherLeaseDto,
  type FormalInteractionFrozenDto,
} from '@sew/study-contracts';
import {
  canonicalJson, classroomDocumentDigest, evidenceBundleDigest, fingerprintOf,
  formalInteractionSceneId, publicFormalInteractionDefinition,
} from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { encodeJson } from '../json-codec';
import { defaultJsonPolicy, readAuthoritativeJsonColumn, type Row } from './types';
import type { LessonVersionRow, ClassroomLinkRow, EvidenceBundleRow } from './types';
import type { ClassroomDocumentRow, ClassroomSceneSourceRow } from './classroom';
import type { ClassroomAssetBindingRow, ClassroomAssetRow } from './classroom-assets';

export interface CreateLocalClassroomRoomInput { projectId: string; lessonId: string; lessonVersion: number; requestId: string }
export interface ClassroomRoomSceneInput { projectId: string; roomId: string; expectedRevision: number; sceneId: string; requestId: string }
export interface ClassroomRoomCloseInput { projectId: string; roomId: string; expectedRevision: number; requestId: string }
export interface ClassroomTeacherLeaseAcquireInput { projectId: string; roomId: string; executorId: string; ttlMs: number }
export interface ClassroomTeacherLeaseCheckInput { projectId: string; roomId: string; leaseId: string; executorId: string; runGeneration: number }
export interface ClassroomRoomWriteResult { room: ClassroomRoomDto; deduplicated: boolean }
export interface FrozenRoomAsset { assetId: string; bytes: Uint8Array }
export interface FreezeRoomCourseResult { snapshot: ClassroomSharedCourseDto; assets: FrozenRoomAsset[] }
/**
 * 创建房间时可选的冻结输入。
 *
 * 正式互动的公开定义由调用方（应用层，已做完整复验）提供；存储层不自己再读一遍，
 * 否则会出现「两条读取路径校验强度不同」的漂移——共享出去的定义必须来自
 * 与本地课堂完全相同的那一次校验。
 */
export interface FreezeRoomCourseOptions { interactionDefinitions?: FormalInteractionFrozenDto | null }
export interface ClassroomRoomFacts {
  boundUid(projectId: string): string | null;
  freeze(input: CreateLocalClassroomRoomInput, options?: FreezeRoomCourseOptions): FreezeRoomCourseResult;
  assertCourseReady(projectId: string, course: ClassroomRoomDto['course']): void;
}

const id = z.string().min(1).max(200);
const createSchema = z.object({ projectId: id, lessonId: id, lessonVersion: z.number().int().positive(), requestId: id }).strict();
const sceneSchema = z.object({ projectId: id, roomId: id, expectedRevision: z.number().int().positive(), sceneId: id, requestId: id }).strict();
const closeSchema = sceneSchema.omit({ sceneId: true });
const acquireSchema = z.object({ projectId: id, roomId: id, executorId: id, ttlMs: z.number().int().min(1000).max(120_000) }).strict();
const checkSchema = z.object({ projectId: id, roomId: id, leaseId: id, executorId: id, runGeneration: z.number().int().positive() }).strict();
const resultSchema = z.object({ room: classroomRoomSchema, deduplicated: z.boolean() }).strict();
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const validate = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
  return parsed.data;
};
const integrityError = (reason: string): StudyError => new StudyError('INTERNAL', { reason });

/** Export plain text; only the formal builder's presentational markup is accepted. */
const sharedSlideText = (markup: string): string => {
  const tags = markup.match(/<[^>]*>/g) ?? [];
  const allowedTag = /^<\/?(?:h[1-3]|p|span|strong|b|em|i|code)(?:\s+style="[a-zA-Z0-9:#;.%\s-]*")?\s*>$|^<br\s*\/?>$/;
  if (tags.some(tag => !allowedTag.test(tag)) || /<!--|<!|<\?/.test(markup)) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'room_slide_markup_unsupported' }, '共享课件只支持纯文字，外部资源和执行代码需要单独登记审核。');
  }
  return markup.replace(/<br\s*\/?>|<\/(?:p|h[1-3])>/g, '\n').replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
};

const textElementInput = z.object({
  id, type: z.literal('text'), left: z.number(), top: z.number(), width: z.number(), height: z.number(), rotate: z.number().default(0), content: z.string(),
}).passthrough();
const slideInput = z.object({
  id, type: z.literal('slide'), title: z.string(), order: z.number().int().nonnegative(),
  content: z.object({ type: z.literal('slide'), schemaVersion: z.literal(1), canvas: z.object({ elements: z.array(textElementInput).min(1) }).passthrough() }).passthrough(),
}).passthrough();
const quizInput = z.object({
  id, type: z.literal('quiz'), title: z.string(), order: z.number().int().nonnegative(),
  content: z.object({ type: z.literal('quiz'), questions: z.array(z.object({
    id, type: z.enum(['single', 'multiple', 'short_answer']), question: z.string(),
    options: z.array(z.object({ value: id, label: z.string() }).strict()).default([]),
  }).passthrough()).min(1) }).passthrough(),
}).passthrough();
const interactiveInput = z.object({
  id, type: z.literal('interactive'), title: z.string(), order: z.number().int().nonnegative(),
  // 互动场景自带的 HTML 由本地宿主渲染，**不进入共享投影**；这里只用于识别场景身份。
  content: z.object({ type: z.literal('interactive'), html: z.string() }).passthrough(),
}).passthrough();
const documentInput = z.object({ stage: z.object({ id }).passthrough(), dslVersion: z.string(), scenes: z.array(z.discriminatedUnion('type', [slideInput, quizInput, interactiveInput])).min(1) }).passthrough();

/** Explicitly constructs a portable course from authoritative rows; arbitrary DSL and metadata are never copied. */
export const freezePublishedRoomCourse = (input: {
  projectId: string; lesson: LessonVersionRow; link: ClassroomLinkRow; bundle: EvidenceBundleRow;
  document: ClassroomDocumentRow; sceneSources: ClassroomSceneSourceRow[]; bindings: ClassroomAssetBindingRow[];
  /** 该课程版本已审核冻结的正式互动定义；没有互动场景时必须为 null。 */
  interactionDefinitions: FormalInteractionFrozenDto | null;
  lookupSegment(materialId: string, revision: number, segmentId: string): { materialId: string; revision: number; segmentId: string; text: string; fingerprint: string } | undefined;
  asset(assetId: string): ClassroomAssetRow | null;
}): FreezeRoomCourseResult => {
  const { lesson, link, bundle, document } = input;
  if (lesson.status !== 'published' || link.lessonVersion !== lesson.version || link.status !== 'published' || link.stageId !== document.stageId
    || document.lessonId !== lesson.lessonId || document.recordScope !== 'formal' || bundle.bundle.recordScope !== 'formal'
    || bundle.projectId !== input.projectId || bundle.bundle.projectId !== input.projectId
    || bundle.digest !== lesson.bundleDigest || bundle.digest !== evidenceBundleDigest(bundle.bundle)
    || document.digest !== link.documentDigest || document.digest !== classroomDocumentDigest(document.document)) throw integrityError('room_source_digest_mismatch');
  const parsed = documentInput.safeParse(document.document);
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT', { reason: 'room_shared_scene_type_unsupported' }, '这份课程暂不支持安全共享，请使用已支持的正式幻灯片和测验场景');
  if (parsed.data.stage.id !== document.stageId || parsed.data.dslVersion !== document.dslVersion) throw integrityError('room_document_identity_mismatch');
  const scenes: ClassroomSharedCourseDto['scenes'] = parsed.data.scenes.map(scene => {
    if (scene.type === 'slide') return {
      sceneId: scene.id, type: 'slide' as const, title: scene.title, order: scene.order,
      elements: scene.content.canvas.elements.map(element => ({
        elementId: element.id, type: 'text' as const, left: element.left, top: element.top, width: element.width,
        height: element.height, rotate: element.rotate, text: sharedSlideText(element.content),
      })),
    };
    if (scene.type === 'quiz') return {
      sceneId: scene.id, type: 'quiz' as const, title: scene.title, order: scene.order,
      questions: scene.content.questions.map(question => ({ questionId: question.id, type: question.type, stem: question.question, options: question.options })),
    };
    // 正式互动：只投影**已审核公开定义**。场景自带 HTML、评分规则、正确目标与私人观察都不进快照。
    const definition = input.interactionDefinitions?.definitions.find(item => formalInteractionSceneId(item.id) === scene.id);
    if (!definition || input.interactionDefinitions?.lessonId !== lesson.lessonId || input.interactionDefinitions?.lessonVersion !== lesson.version
      || input.interactionDefinitions?.bundleDigest !== bundle.digest) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'room_interaction_definition_missing', sceneId: scene.id },
        '这个互动场景缺少已审核的公开定义，暂不支持安全共享。');
    }
    const shared = publicFormalInteractionDefinition(definition);
    if (shared.kind === 'parameter') {
      return {
        sceneId: scene.id, type: 'interactive' as const, title: scene.title, order: scene.order,
        interaction: {
          interactionId: shared.id, kind: 'parameter' as const, title: shared.title, statementIds: shared.statementIds,
          formula: shared.formula, min: shared.min, max: shared.max, step: shared.step, intercept: shared.intercept,
          predictionRequired: shared.predictionRequired,
        },
      };
    }
    if (shared.kind === 'concept_relation') {
      return {
        sceneId: scene.id, type: 'interactive' as const, title: scene.title, order: scene.order,
        interaction: {
          interactionId: shared.id, kind: 'concept_relation' as const, title: shared.title, statementIds: shared.statementIds,
          nodes: shared.nodes, edges: shared.edges,
        },
      };
    }
    // 排序互动：公开投影只给候选条目，正确顺序 `correctOrder` 不进共享快照。
    return {
      sceneId: scene.id, type: 'interactive' as const, title: scene.title, order: scene.order,
      interaction: {
        interactionId: shared.id, kind: 'ordering' as const, title: shared.title, statementIds: shared.statementIds,
        items: shared.items,
      },
    };
  });
  const sceneIds = new Set(scenes.map(scene => scene.sceneId));
  const sources = input.sceneSources.filter(source => sceneIds.has(source.sceneId));
  if (sources.length !== scenes.length || sources.some(source => source.recordScope !== 'formal' || !source.reviewedBy || !source.knowledgeIds.length)) throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING');
  const usedKnowledge = new Set(sources.flatMap(source => source.knowledgeIds));
  const statements = bundle.bundle.statements.filter(statement => lesson.statementIds.includes(statement.statementId) && usedKnowledge.has(statement.knowledgeId));
  if ([...usedKnowledge].some(knowledgeId => !statements.some(statement => statement.knowledgeId === knowledgeId))) throw new StudyError('SOURCE_MISSING');
  const refs = new Map(statements.flatMap(statement => statement.evidence.map(ref => [`${ref.materialId}:${ref.revision}:${ref.segmentId}`, ref] as const)));
  const segments = [...refs.values()].map(ref => {
    const segment = input.lookupSegment(ref.materialId, ref.revision, ref.segmentId);
    const frozen = bundle.bundle.segmentDigests.find(item => item.materialId === ref.materialId && item.revision === ref.revision && item.segmentId === ref.segmentId);
    if (!segment || !frozen) throw new StudyError('SOURCE_SEGMENT_NOT_FOUND');
    if (segment.fingerprint !== frozen.fingerprint || fingerprintOf(segment.text) !== frozen.fingerprint) throw new StudyError('SOURCE_FINGERPRINT_MISMATCH');
    return { materialId: segment.materialId, revision: segment.revision, segmentId: segment.segmentId, fingerprint: segment.fingerprint, text: segment.text };
  });
  const manifest: ClassroomSharedCourseDto['assets'] = [];
  const assetBytes: FrozenRoomAsset[] = [];
  const bindings = input.bindings.filter(binding => sceneIds.has(binding.sceneId));
  if (input.bindings.some(binding => !sceneIds.has(binding.sceneId) || binding.recordScope !== 'formal')) throw integrityError('room_asset_binding_invalid');
  for (const assetId of [...new Set(bindings.map(binding => binding.assetId))]) {
    const asset = input.asset(assetId);
    if (!asset || asset.recordScope !== 'formal') throw integrityError('room_source_asset_missing');
    manifest.push({ assetId, mediaType: asset.mediaType, sha256: asset.sha256, byteLength: asset.bytes.byteLength, revision: asset.revision,
      bindings: bindings.filter(binding => binding.assetId === assetId).map(binding => ({ sceneId: binding.sceneId, slot: binding.slot })) });
    assetBytes.push({ assetId, bytes: new Uint8Array(asset.bytes) });
  }
  const snapshot = validate(classroomSharedCourseSchema, {
    snapshotVersion: 1,
    course: { lessonId: lesson.lessonId, lessonVersion: lesson.version, title: lesson.title, stageId: document.stageId, dslVersion: document.dslVersion,
      documentDigest: document.digest, bundleDigest: bundle.digest },
    scenes,
    evidence: { planVersion: bundle.bundle.planVersion, knowledgeVersions: bundle.bundle.knowledgeVersions.filter(point => usedKnowledge.has(point.knowledgeId)),
      statements: statements.map(statement => ({ statementId: statement.statementId, knowledgeId: statement.knowledgeId, text: statement.text, conditions: statement.conditions,
        evidence: statement.evidence.map(ref => ({ materialId: ref.materialId, revision: ref.revision, segmentId: ref.segmentId, use: ref.use })) })), segments },
    sceneSources: sources.map(source => ({ sceneId: source.sceneId, knowledgeIds: source.knowledgeIds, questionId: source.questionId })), assets: manifest,
  });
  return { snapshot, assets: assetBytes };
};

/** The local service owns this single-user authority. It is not an online identity or collaboration server. */
export class ClassroomRoomRepository {
  constructor(private readonly db: SqlDatabase, private readonly facts: ClassroomRoomFacts) {}

  private principal(projectId: string, trustedUid: string): void {
    if (!learnerUidSchema.safeParse(trustedUid).success || this.facts.boundUid(projectId) !== trustedUid) {
      throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'room_local_identity_mismatch' });
    }
  }

  private readRoom(projectId: string, roomId: string): ClassroomRoomDto | null {
    const row = this.db.prepare('SELECT room_json FROM classroom_rooms WHERE project_id=? AND room_id=?').get(projectId, roomId) as Row | undefined;
    if (!row) return null;
    const room = readAuthoritativeJsonColumn(row['room_json'], classroomRoomSchema, 'classroom_rooms.room_json', defaultJsonPolicy);
    if (room.roomId !== roomId || room.mode !== 'local_single') throw integrityError('room_identity_invalid');
    const members = this.db.prepare('SELECT member_json FROM classroom_room_members WHERE project_id=? AND room_id=? ORDER BY uid').all(projectId, roomId) as Row[];
    const actual = members.map(member => readAuthoritativeJsonColumn(member['member_json'], classroomRoomMemberSchema, 'classroom_room_members.member_json', defaultJsonPolicy));
    if (room.members.length !== 1 || actual.length !== 1 || hash(actual) !== hash(room.members)
      || actual[0]?.uid !== room.ownerUid || actual[0].role !== 'owner'
      || actual[0].identityAuthority !== 'local_only' || !actual[0].canControl) throw integrityError('room_members_invalid');
    return room;
  }

  get(projectId: string, roomId: string, trustedUid: string): ClassroomRoomDto | null {
    this.principal(projectId, trustedUid);
    const room = this.readRoom(projectId, roomId);
    if (!room) return null;
    if (!room.members.some(member => member.uid === trustedUid && member.status === 'joined')) throw new StudyError('ROLE_PERMISSION_DENIED');
    return room;
  }

  list(projectId: string, trustedUid: string): ClassroomRoomDto[] {
    this.principal(projectId, trustedUid);
    const rows = this.db.prepare('SELECT room_id FROM classroom_rooms WHERE project_id=? ORDER BY rowid DESC').all(projectId) as Row[];
    return rows.map(row => this.get(projectId, String(row['room_id']), trustedUid)).filter((room): room is ClassroomRoomDto => room !== null);
  }

  private requireRoom(projectId: string, roomId: string, trustedUid: string): ClassroomRoomDto {
    const room = this.get(projectId, roomId, trustedUid);
    if (!room) throw new StudyError('NOT_FOUND');
    return room;
  }

  private controller(projectId: string, roomId: string, trustedUid: string): ClassroomRoomDto {
    const room = this.requireRoom(projectId, roomId, trustedUid);
    if (room.ownerUid !== trustedUid || !room.members.some(member => member.uid === trustedUid && member.canControl)) throw new StudyError('ROLE_PERMISSION_DENIED');
    return room;
  }

  private active(room: ClassroomRoomDto): void {
    if (room.status === 'ended') throw new StudyError('RUN_TERMINATED', { reason: 'room_ended' });
  }

  private retry(projectId: string, requestId: string, trustedUid: string, action: string, intent: unknown): ClassroomRoomWriteResult | null {
    const row = this.db.prepare('SELECT * FROM classroom_room_receipts WHERE project_id=? AND request_id=?').get(projectId, requestId) as Row | undefined;
    if (!row) return null;
    if (row['actor_uid'] !== trustedUid || row['action'] !== action || row['intent_json'] !== encodeJson(intent)) throw new StudyError('VERSION_CONFLICT', { reason: 'room_request_changed' });
    const result = readAuthoritativeJsonColumn(row['result_json'], resultSchema, 'classroom_room_receipts.result_json', defaultJsonPolicy);
    this.requireRoom(projectId, result.room.roomId, trustedUid);
    return { ...result, deduplicated: true };
  }

  private receipt(projectId: string, requestId: string, uid: string, action: string, intent: unknown, room: ClassroomRoomDto): ClassroomRoomWriteResult {
    const result = { room, deduplicated: false };
    this.db.prepare('INSERT INTO classroom_room_receipts(project_id,request_id,actor_uid,action,intent_json,result_json) VALUES(?,?,?,?,?,?)')
      .run(projectId, requestId, uid, action, encodeJson(intent), encodeJson(result));
    return result;
  }

  private verifySnapshot(snapshot: ClassroomSharedCourseDto): void {
    const scenes = new Set(snapshot.scenes.map(scene => scene.sceneId));
    const sources = new Set(snapshot.sceneSources.map(source => source.sceneId));
    const knowledge = new Set(snapshot.evidence.knowledgeVersions.map(point => point.knowledgeId));
    const segmentKeys = snapshot.evidence.segments.map(segment => `${segment.materialId}:${segment.revision}:${segment.segmentId}`);
    const segments = new Set(segmentKeys);
    if (scenes.size !== snapshot.scenes.length || sources.size !== snapshot.sceneSources.length || scenes.size !== sources.size
      || [...scenes].some(sceneId => !sources.has(sceneId)) || segments.size !== segmentKeys.length
      || knowledge.size !== snapshot.evidence.knowledgeVersions.length
      || snapshot.sceneSources.some(source => source.knowledgeIds.some(knowledgeId => !knowledge.has(knowledgeId)))
      || snapshot.evidence.statements.some(statement => !knowledge.has(statement.knowledgeId)
        || statement.evidence.some(ref => !segments.has(`${ref.materialId}:${ref.revision}:${ref.segmentId}`)))
      || new Set(snapshot.assets.map(asset => asset.assetId)).size !== snapshot.assets.length
      || snapshot.assets.some(asset => asset.bindings.some(binding => !scenes.has(binding.sceneId)))) {
      throw integrityError('room_snapshot_references_invalid');
    }
  }

  snapshot(projectId: string, roomId: string, trustedUid: string): ClassroomSharedCourseDto {
    const room = this.requireRoom(projectId, roomId, trustedUid);
    const row = this.db.prepare('SELECT snapshot_json FROM classroom_rooms WHERE project_id=? AND room_id=?').get(projectId, roomId) as Row;
    const snapshot = readAuthoritativeJsonColumn(row['snapshot_json'], classroomSharedCourseSchema, 'classroom_rooms.snapshot_json', defaultJsonPolicy);
    this.verifySnapshot(snapshot);
    if (hash(snapshot) !== room.snapshotDigest || hash(snapshot.course) !== hash(room.course)) throw integrityError('room_snapshot_digest_mismatch');
    for (const manifest of snapshot.assets) {
      const asset = this.db.prepare('SELECT bytes FROM classroom_room_assets WHERE project_id=? AND room_id=? AND asset_id=?').get(projectId, roomId, manifest.assetId) as Row | undefined;
      if (!asset || !(asset['bytes'] instanceof Uint8Array) || asset['bytes'].byteLength !== manifest.byteLength || bytesHash(asset['bytes']) !== manifest.sha256) throw integrityError('room_asset_digest_mismatch');
    }
    return snapshot;
  }

  asset(projectId: string, roomId: string, trustedUid: string, assetId: string): { assetId: string; mediaType: string; sha256: string; bytes: Uint8Array } | null {
    const snapshot = this.snapshot(projectId, roomId, trustedUid);
    const manifest = snapshot.assets.find(asset => asset.assetId === assetId);
    if (!manifest) return null;
    const row = this.db.prepare('SELECT bytes FROM classroom_room_assets WHERE project_id=? AND room_id=? AND asset_id=?').get(projectId, roomId, assetId) as Row | undefined;
    if (!row || !(row['bytes'] instanceof Uint8Array)) throw integrityError('room_asset_missing');
    const bytes = new Uint8Array(row['bytes']);
    if (bytes.byteLength !== manifest.byteLength || bytesHash(bytes) !== manifest.sha256) throw integrityError('room_asset_digest_mismatch');
    return { assetId, mediaType: manifest.mediaType, sha256: manifest.sha256, bytes };
  }

  /**
   * 只读冻结某已发布课程版本的公共投影（不建房、不落库）。
   *
   * 供在线客户端在「发布共享快照」时复用与建房完全相同的冻结路径：共享出去的
   * 投影必须来自与本地课堂相同的校验，而不是另写一条更弱的读取路径。
   */
  freezeCourse(
    input: { projectId: string; lessonId: string; lessonVersion: number },
    trustedUid: string,
    options?: FreezeRoomCourseOptions,
  ): ClassroomSharedCourseDto {
    this.principal(input.projectId, trustedUid);
    const frozen = this.facts.freeze(
      { ...input, requestId: 'freeze-only' },
      options,
    );
    const snapshot = validate(classroomSharedCourseSchema, frozen.snapshot);
    this.verifySnapshot(snapshot);
    if (
      snapshot.course.lessonId !== input.lessonId ||
      snapshot.course.lessonVersion !== input.lessonVersion
    ) {
      throw integrityError('room_frozen_course_mismatch');
    }
    return snapshot;
  }

  create(raw: CreateLocalClassroomRoomInput, trustedUid: string, options?: FreezeRoomCourseOptions): ClassroomRoomWriteResult {    const input = validate(createSchema, raw);
    this.principal(input.projectId, trustedUid);
    return this.db.transaction(() => {
      const prior = this.retry(input.projectId, input.requestId, trustedUid, 'create', input);
      if (prior) return prior;
      const frozen = this.facts.freeze(input, options);
      const snapshot = validate(classroomSharedCourseSchema, frozen.snapshot);
      this.verifySnapshot(snapshot);
      if (snapshot.course.lessonId !== input.lessonId || snapshot.course.lessonVersion !== input.lessonVersion) throw integrityError('room_frozen_course_mismatch');
      if (encodeJson(snapshot).length > 4 * 1024 * 1024) throw new StudyError('INVALID_ARGUMENT', { reason: 'room_snapshot_too_large' });
      if (new Set(frozen.assets.map(asset => asset.assetId)).size !== frozen.assets.length || frozen.assets.length !== snapshot.assets.length) throw integrityError('room_asset_manifest_mismatch');
      let totalBytes = 0;
      for (const manifest of snapshot.assets) {
        const asset = frozen.assets.find(item => item.assetId === manifest.assetId);
        if (!asset || !(asset.bytes instanceof Uint8Array) || asset.bytes.byteLength !== manifest.byteLength || bytesHash(asset.bytes) !== manifest.sha256) throw integrityError('room_asset_digest_mismatch');
        totalBytes += asset.bytes.byteLength;
      }
      if (totalBytes > 128 * 1024 * 1024) throw new StudyError('INVALID_ARGUMENT', { reason: 'room_assets_too_large' });
      const now = new Date().toISOString();
      const room: ClassroomRoomDto = {
        schemaVersion: 1, roomId: newId<'room'>('room'), mode: 'local_single', ownerUid: trustedUid,
        status: 'ready', revision: 1, runGeneration: 0, currentSceneId: snapshot.scenes[0]!.sceneId,
        snapshotDigest: hash(snapshot), course: snapshot.course,
        members: [{ uid: trustedUid, role: 'owner', identityAuthority: 'local_only', status: 'joined', canControl: true }],
        createdAt: now, updatedAt: now,
      };
      this.db.prepare('INSERT INTO classroom_rooms(project_id,room_id,room_json,snapshot_json,lease_json) VALUES(?,?,?,?,NULL)')
        .run(input.projectId, room.roomId, encodeJson(room), encodeJson(snapshot));
      this.db.prepare('INSERT INTO classroom_room_members(project_id,room_id,uid,member_json) VALUES(?,?,?,?)')
        .run(input.projectId, room.roomId, trustedUid, encodeJson(room.members[0]));
      for (const asset of frozen.assets) this.db.prepare('INSERT INTO classroom_room_assets(project_id,room_id,asset_id,bytes) VALUES(?,?,?,?)')
        .run(input.projectId, room.roomId, asset.assetId, new Uint8Array(asset.bytes));
      return this.receipt(input.projectId, input.requestId, trustedUid, 'create', input, room);
    });
  }

  private saveRoom(projectId: string, room: ClassroomRoomDto): void {
    this.db.prepare('UPDATE classroom_rooms SET room_json=? WHERE project_id=? AND room_id=?').run(encodeJson(classroomRoomSchema.parse(room)), projectId, room.roomId);
  }

  setScene(raw: ClassroomRoomSceneInput, trustedUid: string): ClassroomRoomWriteResult {
    const input = validate(sceneSchema, raw);
    return this.db.transaction(() => {
      const room = this.controller(input.projectId, input.roomId, trustedUid);
      const prior = this.retry(input.projectId, input.requestId, trustedUid, 'scene', input);
      if (prior) return prior;
      this.active(room);
      if (room.revision !== input.expectedRevision) throw new StudyError('VERSION_CONFLICT');
      this.facts.assertCourseReady(input.projectId, room.course);
      const snapshot = this.snapshot(input.projectId, input.roomId, trustedUid);
      if (!snapshot.scenes.some(scene => scene.sceneId === input.sceneId)) throw new StudyError('INVALID_ARGUMENT', { reason: 'room_scene_not_found' });
      const next = { ...room, currentSceneId: input.sceneId, status: 'active' as const, revision: room.revision + 1, updatedAt: new Date().toISOString() };
      this.saveRoom(input.projectId, next);
      return this.receipt(input.projectId, input.requestId, trustedUid, 'scene', input, next);
    });
  }

  close(raw: ClassroomRoomCloseInput, trustedUid: string): ClassroomRoomWriteResult {
    const input = validate(closeSchema, raw);
    return this.db.transaction(() => {
      const room = this.controller(input.projectId, input.roomId, trustedUid);
      const prior = this.retry(input.projectId, input.requestId, trustedUid, 'close', input);
      if (prior) return prior;
      this.active(room);
      if (room.revision !== input.expectedRevision) throw new StudyError('VERSION_CONFLICT');
      const next = { ...room, status: 'ended' as const, revision: room.revision + 1, runGeneration: room.runGeneration + 1, updatedAt: new Date().toISOString() };
      this.saveRoom(input.projectId, next);
      this.db.prepare('UPDATE classroom_rooms SET lease_json=NULL WHERE project_id=? AND room_id=?').run(input.projectId, input.roomId);
      return this.receipt(input.projectId, input.requestId, trustedUid, 'close', input, next);
    });
  }

  private readLease(projectId: string, roomId: string): ClassroomTeacherLeaseDto | null {
    const row = this.db.prepare('SELECT lease_json FROM classroom_rooms WHERE project_id=? AND room_id=?').get(projectId, roomId) as Row | undefined;
    if (row?.['lease_json'] === null) return null;
    return readAuthoritativeJsonColumn(row?.['lease_json'], classroomTeacherLeaseSchema, 'classroom_rooms.lease_json', defaultJsonPolicy);
  }

  acquireLease(raw: ClassroomTeacherLeaseAcquireInput, trustedUid: string): ClassroomTeacherLeaseDto {
    const input = validate(acquireSchema, raw);
    return this.db.transaction(() => {
      const room = this.controller(input.projectId, input.roomId, trustedUid);
      this.active(room);
      this.facts.assertCourseReady(input.projectId, room.course);
      this.snapshot(input.projectId, input.roomId, trustedUid);
      const old = this.readLease(input.projectId, input.roomId);
      if (old && (old.roomId !== room.roomId || old.holderUid !== room.ownerUid || old.runGeneration !== room.runGeneration)) throw integrityError('room_teacher_lease_identity_invalid');
      if (old && Date.parse(old.expiresAt) > Date.now()) {
        if (old.executorId !== input.executorId || old.holderUid !== trustedUid) throw new StudyError('VERSION_CONFLICT', { reason: 'room_teacher_lease_owned' });
        return old;
      }
      const lease: ClassroomTeacherLeaseDto = {
        roomId: room.roomId, leaseId: newId<'lease'>('lease'), holderUid: trustedUid, executorId: input.executorId,
        runGeneration: room.runGeneration + 1, expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
      };
      this.saveRoom(input.projectId, { ...room, runGeneration: lease.runGeneration, updatedAt: new Date().toISOString() });
      this.db.prepare('UPDATE classroom_rooms SET lease_json=? WHERE project_id=? AND room_id=?').run(encodeJson(lease), input.projectId, input.roomId);
      return lease;
    });
  }

  private checkLease(input: ClassroomTeacherLeaseCheckInput, uid: string, sourceCheck: boolean): ClassroomTeacherLeaseDto {
    const room = this.controller(input.projectId, input.roomId, uid);
    this.active(room);
    const lease = this.readLease(input.projectId, input.roomId);
    if (!lease || lease.leaseId !== input.leaseId || lease.executorId !== input.executorId || lease.holderUid !== uid
      || lease.runGeneration !== input.runGeneration || room.runGeneration !== input.runGeneration || lease.roomId !== input.roomId
      || Date.parse(lease.expiresAt) <= Date.now()) throw new StudyError('VERSION_CONFLICT', { reason: 'room_teacher_lease_stale' });
    if (sourceCheck) {
      this.facts.assertCourseReady(input.projectId, room.course);
      this.snapshot(input.projectId, input.roomId, uid);
    }
    return lease;
  }

  assertLease(raw: ClassroomTeacherLeaseCheckInput, trustedUid: string): ClassroomTeacherLeaseDto {
    return this.checkLease(validate(checkSchema, raw), trustedUid, true);
  }

  renewLease(raw: ClassroomTeacherLeaseCheckInput & { ttlMs: number }, trustedUid: string): ClassroomTeacherLeaseDto {
    const input = validate(checkSchema.extend({ ttlMs: z.number().int().min(1000).max(120_000) }), raw);
    return this.db.transaction(() => {
      const { ttlMs, ...check } = input;
      const lease = this.checkLease(check, trustedUid, true);
      const next = { ...lease, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
      this.db.prepare('UPDATE classroom_rooms SET lease_json=? WHERE project_id=? AND room_id=?').run(encodeJson(next), input.projectId, input.roomId);
      return next;
    });
  }

  releaseLease(raw: ClassroomTeacherLeaseCheckInput, trustedUid: string): void {
    const input = validate(checkSchema, raw);
    this.db.transaction(() => {
      this.checkLease(input, trustedUid, false);
      this.db.prepare('UPDATE classroom_rooms SET lease_json=NULL WHERE project_id=? AND room_id=?').run(input.projectId, input.roomId);
    });
  }

  bindSession(projectId: string, roomId: string, sessionId: string, trustedUid: string): ClassroomRoomDto {
    validate(z.object({ projectId: id, roomId: id, sessionId: id }).strict(), { projectId, roomId, sessionId });
    return this.db.transaction(() => {
      const room = this.controller(projectId, roomId, trustedUid);
      this.active(room);
      this.facts.assertCourseReady(projectId, room.course);
      this.snapshot(projectId, roomId, trustedUid);
      const session = this.db.prepare('SELECT * FROM classroom_sessions WHERE project_id=? AND session_id=?').get(projectId, sessionId) as Row | undefined;
      if (!session || session['lesson_id'] !== room.course.lessonId || session['lesson_version'] !== room.course.lessonVersion
        || session['stage_id'] !== room.course.stageId || session['learner_key'] !== LEGACY_LOCAL_LEARNER_KEY
        || session['current_scene_id'] !== room.currentSceneId || !['in_class', 'awaiting_learner'].includes(String(session['status']))) {
        throw new StudyError('VERSION_CONFLICT', { reason: 'room_session_mismatch' });
      }
      const existing = this.db.prepare('SELECT room_id,session_id FROM classroom_room_session_bindings WHERE project_id=? AND (room_id=? OR session_id=?)').all(projectId, roomId, sessionId) as Row[];
      if (existing.some(binding => binding['room_id'] !== roomId || binding['session_id'] !== sessionId)) throw new StudyError('VERSION_CONFLICT', { reason: 'room_session_already_bound' });
      if (existing.length === 0) this.db.prepare('INSERT INTO classroom_room_session_bindings(project_id,room_id,session_id) VALUES(?,?,?)').run(projectId, roomId, sessionId);
      return room;
    });
  }

  forSession(projectId: string, sessionId: string, trustedUid: string): ClassroomRoomDto | null {
    this.principal(projectId, trustedUid);
    const binding = this.db.prepare('SELECT room_id FROM classroom_room_session_bindings WHERE project_id=? AND session_id=?').get(projectId, sessionId) as Row | undefined;
    return binding ? this.requireRoom(projectId, String(binding['room_id']), trustedUid) : null;
  }
}
