/** Server-owned, immutable personal experiment observations in the runtime store. */
import { createHash } from 'node:crypto';
import { RUNTIME_DSL_VERSION } from '@openmaic/dsl';
import { StudyError, interactionPayloadSchema, interactionSubmissionSchema, interactionSubmitSchema, type InteractionSubmitInput, type InteractionStateDto, type InteractionSubmissionDto } from '@sew/study-contracts';
import { loadRenderableDocument } from './classroom-service';
import { SCENE_INTERACTIVE_ID } from '../classroom/reviewed-lesson';
import { CLASSROOM_OWNER_LEARNER_KEY } from './runtime-storage';
import { assertScope, type Session } from './service';

export const INTERACTION_SESSION_KIND = 'interactionSubmission';
export const INTERACTION_SESSION_PREFIX = 'sew-interaction-v1-';
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const context = (session: Session, stageId: string, sceneId: string) => {
  assertScope({ projectId: session.projectId, generation: session.generation });
  const stored = loadRenderableDocument(session, stageId);
  if (!stored) throw new StudyError('NOT_FOUND');
  if (sceneId !== SCENE_INTERACTIVE_ID) throw new StudyError('INVALID_ARGUMENT', { reason: 'unsupported_interaction_scene' });
  const binding = session.store.listClassroomSceneSources(session.projectId, stageId).get(sceneId);
  if (!binding || binding.reviewedBy.length === 0 || binding.questionId !== null || binding.knowledgeIds.length === 0) {
    throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING');
  }
  const sessionId = INTERACTION_SESSION_PREFIX + hash([session.projectId, stageId, sceneId, stored.digest]);
  return { sessionId, digest: stored.digest };
};

const read = (session: Session, stageId: string, sceneId: string, digest: string, sessionId: string): InteractionSubmissionDto[] => {
  const owner = session.store.runtime.getSession(session.projectId, sessionId);
  if (!owner) return [];
  if (owner.kind !== INTERACTION_SESSION_KIND || owner.learnerKey !== CLASSROOM_OWNER_LEARNER_KEY || owner.stageId !== stageId || owner.status !== 'active' || owner.runtimeDslVersion !== RUNTIME_DSL_VERSION) {
    throw new StudyError('INTERNAL', { reason: 'invalid_interaction_session' });
  }
  return session.store.runtime.listRecords(session.projectId, sessionId).map((record, index) => {
    const result = interactionPayloadSchema.safeParse(record.payload);
    if (!result.success) throw new StudyError('INTERNAL', { reason: 'invalid_interaction_payload' });
    const payload = result.data;
    const expectedDirection = payload.a > 0 ? 'increasing' : payload.a < 0 ? 'decreasing' : 'constant';
    if (record.seq !== index || record.sessionId !== sessionId || record.actionIndex !== undefined || record.subAnchor !== undefined || record.sceneId !== sceneId || payload.sceneId !== sceneId || payload.stageId !== stageId || payload.projectId !== session.projectId || payload.documentDigest !== digest || payload.direction !== expectedDirection || record.id !== 'interaction-v1-' + hash(payload)) {
      throw new StudyError('INTERNAL', { reason: 'interaction_binding_mismatch' });
    }
    const dto = interactionSubmissionSchema.safeParse({ id: record.id, createdAt: record.createdAt, payload });
    if (!dto.success) throw new StudyError('INTERNAL', { reason: 'invalid_interaction_receipt' });
    return dto.data;
  });
};

export const loadInteraction = (session: Session, stageId: string, sceneId: string): InteractionStateDto => {
  const { digest, sessionId } = context(session, stageId, sceneId);
  const records = read(session, stageId, sceneId, digest, sessionId);
  return { lastSubmission: records.at(-1) ?? null, count: records.length, deduplicated: false };
};

export const submitInteraction = (session: Session, input: InteractionSubmitInput): InteractionStateDto => {
  const parsed = interactionSubmitSchema.safeParse(input);
  if (!parsed.success) throw new StudyError('INVALID_ARGUMENT');
  const body = parsed.data;
  assertScope(body.scope);
  if (session.projectId !== body.scope.projectId || session.generation !== body.scope.generation) throw new StudyError('PROJECT_GENERATION_STALE');
  return session.store.transaction(() => {
    const { digest, sessionId } = context(session, body.stageId, body.sceneId);
    const records = read(session, body.stageId, body.sceneId, digest, sessionId);
    const payload = interactionPayloadSchema.parse({
      payloadVersion: 1, projectId: session.projectId, documentDigest: digest,
      actorType: 'human_learner', recordScope: 'demo', stageId: body.stageId, sceneId: body.sceneId,
      a: Object.is(body.a, -0) ? 0 : body.a, prediction: body.prediction, explanation: body.explanation,
      direction: body.a > 0 ? 'increasing' : body.a < 0 ? 'decreasing' : 'constant',
    });
    const id = 'interaction-v1-' + hash(payload);
    const prior = records.find((record) => record.id === id);
    if (prior) return { lastSubmission: prior, count: records.length, deduplicated: true };
    const now = new Date().toISOString();
    if (!session.store.runtime.getSession(session.projectId, sessionId)) {
      session.store.runtime.createSession(session.projectId, {
        id: sessionId, kind: INTERACTION_SESSION_KIND, learnerKey: CLASSROOM_OWNER_LEARNER_KEY,
        stageId: body.stageId, runtimeDslVersion: RUNTIME_DSL_VERSION, status: 'active', createdAt: now, updatedAt: now,
      });
    }
    session.store.runtime.appendRecord(session.projectId, { id, sessionId, sceneId: body.sceneId, createdAt: now, payload }, { expectedLastSeq: records.length === 0 ? null : records.length - 1 });
    return { lastSubmission: { id, createdAt: now, payload }, count: records.length + 1, deduplicated: false };
  });
};
