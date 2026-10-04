import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import { StudyError, formalInteractionFrozenSchema, type FormalInteractionCommand, type FormalInteractionFrozenDto } from '@sew/study-contracts';
import {
  formalInteractionDefinitionSessionId as definitionSessionId,
  formalInteractionHash,
  formalInteractionSceneId,
} from '@sew/study-domain';
import type { Session } from './service';

// 派生规则已下沉到领域层，本地只做转出，保证本地课堂与 ROOM 公共投影用同一份实现。
export { formalInteractionHash, formalInteractionSceneId };
/**
 * 读取已冻结的互动定义，并同时给出**基于原始存储内容**的定义摘要。
 *
 * 摘要必须是「存下来的那份 JSON」的函数，而不是 schema 解析结果的函数：
 * zod 的 `.default()` 会把默认值写进解析结果，一旦以后再加字段，
 * 同一份旧记录会算出不同的摘要，进而让 `binding.definitionDigest` 漂移、
 * 使所有历史互动观察都指向一个读不到的分区。用原始 payload 则新旧记录都稳定。
 */
export const readFormalInteractionDefinitions = (session: Session, lessonId: string, version: number): { frozen: FormalInteractionFrozenDto; digest: string } | null => {
  const sessionId = definitionSessionId(lessonId, version);
  const records = session.store.runtime.listRecords(session.projectId, sessionId);
  if (!records.length) return null;
  const owner = session.store.runtime.getSession(session.projectId, sessionId);
  const raw = records[0]?.payload;
  const payload = formalInteractionFrozenSchema.safeParse(raw);
  // 记录 id 绑定的是**写入时存下的原始 payload**。不能用 schema 解析后的对象算摘要：
  // zod 的 `.default()` 会把默认值写进解析结果，升级前写入、缺新字段的旧记录会因此
  // 算出不同的摘要而被误判为损坏（读取 500）。用原始 payload 则新旧记录都能对上。
  if (records.length !== 1 || !payload.success || !owner || owner.kind !== 'formalInteractionDefinition' || owner.runtimeDslVersion !== RUNTIME_DSL_VERSION || payload.data.lessonId !== lessonId || payload.data.lessonVersion !== version || payload.data.projectId !== session.projectId || records[0]?.id !== `formal-definition-${formalInteractionHash(raw)}`) throw new StudyError('INTERNAL', { reason: 'invalid_frozen_interaction' });
  const lesson = session.store.getLessonVersion(lessonId, version, session.projectId);
  const bundle = lesson ? session.store.getEvidenceBundle(session.projectId, lesson.bundleId) : null;
  if (!bundle || bundle.digest !== payload.data.bundleDigest || owner.learnerKey !== payload.data.reviewedBy || payload.data.definitions.some(d => d.statementIds.some(id => !lesson?.statementIds.includes(id)))) throw new StudyError('VERSION_CONFLICT', { reason: 'interaction_evidence_binding_mismatch' });
  return { frozen: payload.data, digest: formalInteractionHash(raw) };
};
export const reviewFormalInteractionDefinitions = (session: Session, input: Extract<FormalInteractionCommand, { operation: 'review' }>): FormalInteractionFrozenDto => session.store.transaction(() => {
  const lesson = session.store.getLessonVersion(input.lessonId, input.lessonVersion, session.projectId);
  if (!lesson) throw new StudyError('NOT_FOUND');
  if (lesson.status !== 'draft' || session.store.getLessonReview(input.lessonId, input.lessonVersion, session.projectId)) throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', { reason: 'interaction_requires_unreviewed_draft' });
  const bundle = session.store.getEvidenceBundle(session.projectId, lesson.bundleId);
  if (!bundle || bundle.bundle.recordScope !== 'formal') throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED');
  const definitions = input.definitions;
  const knowledgeIds = bundle.bundle.statements.filter(s => definitions.some(d => d.statementIds.includes(s.statementId))).map(s => s.knowledgeId);
  if (!session.store.checkAdmission(knowledgeIds, 'formal').allowed) throw new StudyError('KNOWLEDGE_NOT_VERIFIED');
  if (new Set(definitions.map(d => d.id)).size !== definitions.length || new Set(definitions.map(d => d.kind)).size !== definitions.length) throw new StudyError('INVALID_ARGUMENT');
  for (const definition of definitions) {
    if (new Set(definition.statementIds).size !== definition.statementIds.length || definition.statementIds.some(id => !lesson.statementIds.includes(id) || !bundle.bundle.statements.some(s => s.statementId === id))) throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING');
    if (definition.kind === 'parameter' && (definition.min >= definition.max || definition.step > definition.max - definition.min)) throw new StudyError('INVALID_ARGUMENT');
    if (definition.kind === 'concept_relation') {
      const nodes = new Set(definition.nodes.map(n => n.id));
      if (nodes.size !== definition.nodes.length || new Set(definition.edges.map(e => e.id)).size !== definition.edges.length || definition.edges.some(e => !nodes.has(e.from) || !nodes.has(e.to) || e.from === e.to)) throw new StudyError('INVALID_ARGUMENT');
    }
  }
  const frozen = formalInteractionFrozenSchema.parse({ version: 1, projectId: session.projectId, lessonId: lesson.lessonId, lessonVersion: lesson.version, bundleDigest: bundle.digest, reviewedBy: session.learnerUid, reviewNote: input.reviewNote, definitions });
  const prior = readFormalInteractionDefinitions(session, lesson.lessonId, lesson.version);
  if (prior) {
    if (formalInteractionHash(prior.frozen) !== formalInteractionHash(frozen)) throw new StudyError('VERSION_CONFLICT', { reason: 'interaction_definition_frozen' });
    return prior.frozen;
  }
  const now = new Date().toISOString();
  const sessionId = definitionSessionId(lesson.lessonId, lesson.version);
  session.store.runtime.createSession(session.projectId, { id: sessionId, kind: 'formalInteractionDefinition', learnerKey: session.learnerUid, stageId: `stage_formal_${lesson.lessonId}_v${lesson.version}`, runtimeDslVersion: RUNTIME_DSL_VERSION, status: 'active', createdAt: now, updatedAt: now });
  session.store.runtime.appendRecord(session.projectId, { id: `formal-definition-${formalInteractionHash(frozen)}`, sessionId, createdAt: now, payload: frozen }, { expectedLastSeq: null });
  return frozen;
});
