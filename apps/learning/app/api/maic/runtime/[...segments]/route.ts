import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  RUNTIME_DSL_VERSION,
  isRuntimeSessionStatus,
  validateRuntimeRecord,
  validateRuntimeSession,
} from '@openmaic/dsl';
import { RuntimeAppendConflictError } from '@openmaic/storage';
import { RuntimeAppendConflict, RuntimeSessionExists } from '@sew/study-storage';
import {
  CLASSROOM_OWNER_LEARNER_KEY,
  RuntimeHttpError,
  error,
  readBoundedRuntimeJson,
  revalidateRuntimeScope,
  runtimeRequestScope,
  runtimeRouteError,
} from '../../../../../lib/server/runtime-storage';
import { loadRenderableDocument } from '../../../../../lib/server/classroom-service';
import { INTERACTION_SESSION_KIND, INTERACTION_SESSION_PREFIX } from '../../../../../lib/server/interaction-service';
import { toAttemptDto } from '../../../../../lib/server/dto';
import type { RuntimeRecordRow, RuntimeSessionRow } from '@sew/study-storage';

export const dynamic = 'force-dynamic';

const noStore = { 'cache-control': 'no-store' };
const response = (value: unknown, status = 200): NextResponse => NextResponse.json(value, { status, headers: noStore });
const noContent = (): NextResponse => new NextResponse(null, { status: 204, headers: noStore });
type RouteContext = { params: Promise<{ segments: string[] }> };

const createSessionSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  stageId: z.string().min(1),
  learnerKey: z.string().min(1),
  status: z.literal('active'),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
const statusSchema = z.object({
  status: z.enum(['active', 'archived', 'completed']),
  updatedAt: z.string().datetime({ offset: true }),
  expectedLastSeq: z.number().int().nonnegative().nullable().optional(),
}).strict();
const appendSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  sceneId: z.string().optional(),
  actionIndex: z.number().int().nonnegative().optional(),
  subAnchor: z.string().optional(),
  createdAt: z.string().datetime({ offset: true }),
  payload: z.unknown(),
  expectedLastSeq: z.number().int().nonnegative().nullable().optional(),
  sessionTransition: z.object({ status: z.enum(['active', 'archived', 'completed']), updatedAt: z.string() }).optional(),
}).strict();

const parseJson = async <S extends z.ZodTypeAny>(request: Request, schema: S, scope: { projectId: string; generation: number }): Promise<z.infer<S>> => {
  const raw = await readBoundedRuntimeJson(request, scope);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new RuntimeHttpError(400, 'VALIDATION_FAILED', 'RuntimeStore request body failed validation', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
};

const sessionRecord = (session: RuntimeSessionRow) => ({
  id: session.id,
  runtimeDslVersion: session.runtimeDslVersion,
  kind: session.kind,
  stageId: session.stageId,
  learnerKey: session.learnerKey,
  status: session.status,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
});

const recordDto = (record: RuntimeRecordRow) => ({
  id: record.id,
  sessionId: record.sessionId,
  seq: record.seq,
  ...(record.sceneId === undefined ? {} : { sceneId: record.sceneId }),
  ...(record.actionIndex === undefined ? {} : { actionIndex: record.actionIndex }),
  ...(record.subAnchor === undefined ? {} : { subAnchor: record.subAnchor }),
  createdAt: record.createdAt,
  payload: record.payload,
});

const getOwnedSession = (session: ReturnType<typeof revalidateRuntimeScope>, sessionId: string): RuntimeSessionRow => {
  const stored = session.store.runtime.getSession(session.projectId, sessionId);
  if (!stored || stored.learnerKey !== CLASSROOM_OWNER_LEARNER_KEY) {
    throw new RuntimeHttpError(404, 'SESSION_NOT_FOUND', `Runtime session ${JSON.stringify(sessionId)} was not found`);
  }
  return stored;
};

const validateQuizAppend = (session: RuntimeSessionRow, payload: unknown): void => {
  if (session.kind !== 'quizAttempt') return;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    error(400, 'VALIDATION_FAILED', 'Quiz runtime payload must be an object');
  }
  const value = payload as Record<string, unknown>;
  if (value['phase'] !== 'draft' && value['phase'] !== 'submitted') {
    error(403, 'REVIEW_REQUIRES_SERVER_SCORING', 'Quiz review records are written only by the server submission route');
  }
  if ('results' in value || !value['answers'] || typeof value['answers'] !== 'object' || Array.isArray(value['answers'])) {
    error(403, 'REVIEW_REQUIRES_SERVER_SCORING', 'Client quiz records cannot provide grading results');
  }
};

const dispatch = async (request: Request, context: RouteContext): Promise<NextResponse> => {
  const { scope } = runtimeRequestScope(request);
  const { segments } = await context.params;
  const session = revalidateRuntimeScope(scope);
  const runtime = session.store.runtime;
  const method = request.method.toUpperCase();

  if (segments.length === 1 && segments[0] === 'learner-key' && method === 'GET') {
    return response({ ok: true, data: { learnerKey: CLASSROOM_OWNER_LEARNER_KEY } });
  }
  if (segments.length === 1 && segments[0] === 'submit' && method === 'POST') {
    return submitQuizAttempt(request, scope);
  }
  if (segments.length === 1 && segments[0] === 'sessions' && method === 'POST') {
    const input = await parseJson(request, createSessionSchema, scope);
    if (input.kind === INTERACTION_SESSION_KIND || input.id.startsWith(INTERACTION_SESSION_PREFIX)) error(403, 'INTERACTION_WRITE_FORBIDDEN', 'Personal interaction observations are committed only by the interaction service');
    const current = revalidateRuntimeScope(scope);
    if (!current.store.getClassroomDocument(current.projectId, input.stageId)) {
      error(404, 'STAGE_NOT_FOUND', `Classroom stage ${JSON.stringify(input.stageId)} was not found`);
    }
    const init = {
      ...input,
      learnerKey: CLASSROOM_OWNER_LEARNER_KEY,
      runtimeDslVersion: RUNTIME_DSL_VERSION,
    } satisfies RuntimeSessionRow;
    const result = validateRuntimeSession(init);
    if (!result.valid) error(400, 'VALIDATION_FAILED', 'Invalid runtime session envelope', { errors: result.errors });
    try {
      const created = runtime.createSession(current.projectId, init);
      return response(sessionRecord(created), 201);
    } catch (caught) {
      if (caught instanceof RuntimeSessionExists) error(409, 'SESSION_ALREADY_EXISTS', 'Runtime session id already exists');
      throw caught;
    }
  }
  if (segments.length === 5 && segments[0] === 'stages' && segments[2] === 'learners' && segments[4] === 'sessions' && method === 'GET') {
    const [stageId, learnerKey] = [segments[1] ?? '', segments[3] ?? ''];
    if (!stageId || !learnerKey) error(400, 'VALIDATION_FAILED', 'Invalid runtime partition path');
    if (learnerKey !== CLASSROOM_OWNER_LEARNER_KEY) error(403, 'FORBIDDEN_LEARNER', 'Runtime learner partition is assigned by the service');
    const current = revalidateRuntimeScope(scope);
    const sessions = runtime.listSessions(current.projectId, stageId, CLASSROOM_OWNER_LEARNER_KEY);
    return response(sessions.map(sessionRecord));
  }
  if (segments[0] === 'sessions' && segments.length >= 2) {
    const sessionId = segments[1] ?? '';
    if (!sessionId) error(400, 'VALIDATION_FAILED', 'Runtime session id is required');
    if (segments.length === 2 && method === 'GET') {
      const current = revalidateRuntimeScope(scope);
      return response(sessionRecord(getOwnedSession(current, sessionId)));
    }
    if (segments.length === 2 && method === 'DELETE') {
      const current = revalidateRuntimeScope(scope);
      const owned = runtime.getSession(current.projectId, sessionId);
      if (owned?.kind === INTERACTION_SESSION_KIND) error(403, 'INTERACTION_WRITE_FORBIDDEN', 'Saved personal observations cannot be deleted');
      if (owned?.learnerKey === CLASSROOM_OWNER_LEARNER_KEY && owned.kind === 'quizAttempt' && owned.status === 'completed') {
        error(403, 'SESSION_DELETE_FORBIDDEN', 'A completed scored quiz attempt cannot be deleted');
      }
      if (owned?.learnerKey === CLASSROOM_OWNER_LEARNER_KEY) runtime.deleteSession(current.projectId, sessionId);
      return noContent();
    }
    if (segments.length === 3 && segments[2] === 'status' && method === 'PATCH') {
      const input = await parseJson(request, statusSchema, scope);
      if (!isRuntimeSessionStatus(input.status)) error(400, 'VALIDATION_FAILED', 'Invalid runtime session status');
      if (input.status !== 'archived') {
        error(403, 'REVIEW_REQUIRES_SERVER_SCORING', 'Quiz completion is committed only with a server-scored review record');
      }
      const current = revalidateRuntimeScope(scope);
      const owned = getOwnedSession(current, sessionId);
      if (owned.kind === INTERACTION_SESSION_KIND) error(403, 'INTERACTION_WRITE_FORBIDDEN', 'Saved personal observation sessions cannot be archived');
      if (owned.kind === 'quizAttempt' && owned.status === 'completed') {
        error(403, 'SESSION_ARCHIVE_FORBIDDEN', 'A completed scored quiz attempt must keep its review receipt linked');
      }
      try {
        runtime.setSessionStatus(current.projectId, sessionId, input.status, input.updatedAt, input.expectedLastSeq);
      } catch (caught) {
        if (caught instanceof RuntimeAppendConflict) {
          throw new RuntimeAppendConflictError(caught.sessionId, caught.expectedLastSeq, caught.actualLastSeq);
        }
        throw caught;
      }
      return noContent();
    }
    if (segments.length === 3 && segments[2] === 'records' && method === 'POST') {
      const input = await parseJson(request, appendSchema, scope);
      if (input.sessionId !== sessionId) error(400, 'VALIDATION_FAILED', 'Runtime record sessionId must match the request path');
      if (input.sessionTransition) error(403, 'REVIEW_REQUIRES_SERVER_SCORING', 'Session transitions are only allowed with server-scored records');
      const current = revalidateRuntimeScope(scope);
      const owned = getOwnedSession(current, sessionId);
      if (owned.kind === INTERACTION_SESSION_KIND) error(403, 'INTERACTION_WRITE_FORBIDDEN', 'Personal interaction records are written only by the interaction service');
      validateQuizAppend(owned, input.payload);
      const init = {
        id: input.id,
        sessionId: input.sessionId,
        ...(input.sceneId === undefined ? {} : { sceneId: input.sceneId }),
        ...(input.actionIndex === undefined ? {} : { actionIndex: input.actionIndex }),
        ...(input.subAnchor === undefined ? {} : { subAnchor: input.subAnchor }),
        createdAt: input.createdAt,
        payload: input.payload,
      };
      const validation = validateRuntimeRecord({ ...init, seq: 0 });
      if (!validation.valid) error(400, 'VALIDATION_FAILED', 'Invalid runtime record envelope', { errors: validation.errors });
      try {
        const record = runtime.appendRecord(current.projectId, init, { expectedLastSeq: input.expectedLastSeq });
        return response(recordDto(record), 201);
      } catch (caught) {
        if (caught instanceof RuntimeAppendConflict) {
          throw new RuntimeAppendConflictError(caught.sessionId, caught.expectedLastSeq, caught.actualLastSeq);
        }
        throw caught;
      }
    }
    if (segments.length === 3 && segments[2] === 'records' && method === 'GET') {
      const current = revalidateRuntimeScope(scope);
      const owned = getOwnedSession(current, sessionId);
      const url = new URL(request.url);
      const sceneId = url.searchParams.get('sceneId') ?? undefined;
      if ([...url.searchParams.keys()].some((key) => key !== 'sceneId')) error(400, 'VALIDATION_FAILED', 'Unsupported runtime records query parameter');
      return response(runtime.listRecords(current.projectId, owned.id, sceneId).map(recordDto));
    }
  }
  if (method === 'DELETE' && segments[0] === 'stages' && segments.length === 4 && segments[2] === 'learners') {
    if (segments[3] !== CLASSROOM_OWNER_LEARNER_KEY) error(403, 'FORBIDDEN_LEARNER', 'Runtime learner partition is assigned by the service');
    const current = revalidateRuntimeScope(scope);
    const sessions = runtime.listSessions(current.projectId, segments[1] ?? '', CLASSROOM_OWNER_LEARNER_KEY);
    if (sessions.some((session) => session.kind === INTERACTION_SESSION_KIND || (session.kind === 'quizAttempt' && session.status === 'completed'))) {
      error(403, 'FORBIDDEN', 'Completed quiz evidence and receipts cannot be removed by the learner');
    }
    runtime.deleteLearnerRuntime(current.projectId, segments[1] ?? '', CLASSROOM_OWNER_LEARNER_KEY);
    return noContent();
  }
  if (method === 'POST' && segments.join('/') === 'learners/merge') {
    error(403, 'FORBIDDEN', 'Learner identity merge requires a trusted service operation');
  }
  if (method === 'DELETE' && segments[0] === 'stages' && segments.length === 2) {
    error(403, 'FORBIDDEN', 'Stage runtime deletion is restricted to the trusted document lifecycle');
  }
  if (method === 'DELETE' && segments.length === 1 && segments[0] === 'runtime') {
    error(403, 'FORBIDDEN', 'Bulk runtime deletion is restricted to the trusted service');
  }
  throw new RuntimeHttpError(404, 'NOT_FOUND', 'Unknown RuntimeStore operation');
};

export const GET = async (request: Request, context: RouteContext): Promise<NextResponse> => {
  try { return await dispatch(request, context); } catch (caught) { return runtimeRouteError(caught) as NextResponse; }
};
export const POST = async (request: Request, context: RouteContext): Promise<NextResponse> => {
  try { return await dispatch(request, context); } catch (caught) { return runtimeRouteError(caught) as NextResponse; }
};
export const PATCH = async (request: Request, context: RouteContext): Promise<NextResponse> => {
  try { return await dispatch(request, context); } catch (caught) { return runtimeRouteError(caught) as NextResponse; }
};
export const DELETE = async (request: Request, context: RouteContext): Promise<NextResponse> => {
  try { return await dispatch(request, context); } catch (caught) { return runtimeRouteError(caught) as NextResponse; }
};

const submitQuizSchema = z.object({
  scope: z.object({ projectId: z.string().min(1), generation: z.number().int().positive() }).strict(),
  sessionId: z.string().min(1),
  sceneId: z.string().min(1),
  expectedLastSeq: z.number().int().nonnegative().nullable(),
  questionId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(512),
  answerText: z.string(),
  processText: z.string(),
}).strict();

async function submitQuizAttempt(request: Request, headerScope: { projectId: string; generation: number }): Promise<NextResponse> {
  const body = await parseJson(request, submitQuizSchema, headerScope);
  if (body.scope.projectId !== headerScope.projectId || body.scope.generation !== headerScope.generation) {
    error(409, 'PROJECT_GENERATION_STALE', 'Request body project scope does not match the authorized project');
  }
  const session = revalidateRuntimeScope(headerScope);
  const runtimeSession = getOwnedSession(session, body.sessionId);
  const priorReceipt = session.store.runtime.getQuizReceipt(session.projectId, body.idempotencyKey);
  if (priorReceipt) {
    if (priorReceipt.sessionId !== body.sessionId || priorReceipt.questionId !== body.questionId) {
      throw new RuntimeHttpError(409, 'VERSION_CONFLICT', 'Idempotency key is already bound to another quiz submission');
    }
    const attempt = session.store.getAttemptByIdempotencyKey(body.idempotencyKey);
    const record = session.store.runtime.getRecord(session.projectId, body.sessionId, priorReceipt.recordId);
    if (!attempt || !record || attempt.answerText !== body.answerText || attempt.processText !== body.processText) {
      throw new RuntimeHttpError(409, 'VERSION_CONFLICT', 'Quiz submission retry does not match its durable receipt');
    }
    return response({ ok: true, data: { attempt: toAttemptDto(attempt, true), record: recordDto(record), deduplicated: true } });
  }
  if (runtimeSession.status !== 'active' || runtimeSession.kind !== 'quizAttempt') {
    error(409, 'SESSION_NOT_ACTIVE', 'Quiz runtime session is not active');
  }
  const existingRecords = session.store.runtime.listRecords(session.projectId, body.sessionId);
  if (existingRecords.some((record) => record.sceneId !== undefined && record.sceneId !== body.sceneId)) {
    error(409, 'SCENE_ANCHOR_MISMATCH', 'Quiz runtime session is anchored to another scene');
  }
  const stored = session.store.getClassroomDocument(session.projectId, runtimeSession.stageId);
  if (!stored || !loadRenderableDocument(session, runtimeSession.stageId)) {
    throw new RuntimeHttpError(404, 'STAGE_NOT_FOUND', 'Quiz stage is unavailable or no longer reviewed');
  }
  const document = stored.document as { scenes?: unknown };
  const scenes = Array.isArray(document.scenes) ? document.scenes : [];
  const scene = scenes.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>)['id'] === body.sceneId) as Record<string, unknown> | undefined;
  if (!scene || scene['type'] !== 'quiz' || scene['stageId'] !== runtimeSession.stageId) {
    throw new RuntimeHttpError(400, 'VALIDATION_FAILED', 'Submission scene is not a quiz in the active stage');
  }
  const bindings = session.store.listClassroomSceneSources(session.projectId, runtimeSession.stageId);
  const binding = bindings.get(body.sceneId);
  if (!binding || binding.questionId !== body.questionId || binding.reviewedBy.length === 0) {
    throw new RuntimeHttpError(403, 'QUESTION_BINDING_MISMATCH', 'Quiz question does not match the reviewed scene binding');
  }
  const question = session.store.getQuestion(body.questionId, stored.recordScope);
  if (!question) throw new RuntimeHttpError(404, 'QUESTION_NOT_FOUND', 'Bound quiz question was not found');
  const content = scene['content'] && typeof scene['content'] === 'object' ? scene['content'] as Record<string, unknown> : null;
  const questionList = content?.['questions'];
  const dslQuestion = Array.isArray(questionList)
    ? questionList.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>)['id'] !== undefined) as Record<string, unknown> | undefined
    : undefined;
  const dslQuestionId = typeof dslQuestion?.['id'] === 'string' ? dslQuestion['id'] : '';
  if (!dslQuestionId || dslQuestionListMismatch(questionList, dslQuestionId, question.stem)) {
    throw new RuntimeHttpError(403, 'QUESTION_BINDING_MISMATCH', 'Quiz document no longer matches the bound question');
  }
  const expectedChoice = singleChoiceAnswer(dslQuestion ?? {});
  if (expectedChoice === null) {
    error(422, 'QUIZ_SCORING_UNSUPPORTED', 'This quiz question type cannot be scored by the local runtime');
  }
  if (body.answerText.length === 0 || body.answerText.length > 10_000) {
    error(400, 'VALIDATION_FAILED', 'Quiz answer text is empty or exceeds the limit');
  }
  if (body.processText.length > 10_000) error(400, 'VALIDATION_FAILED', 'Quiz process text exceeds the limit');
  if (question.answer !== expectedChoice) {
    error(403, 'QUESTION_BINDING_MISMATCH', 'The scored answer key differs from the reviewed quiz document');
  }
  if (session.store.getAttemptByIdempotencyKey(body.idempotencyKey)) {
    error(409, 'VERSION_CONFLICT', 'Attempt already exists without a matching runtime receipt');
  }

  const answers: Record<string, unknown> = {
    [dslQuestionId]: body.answerText,
    [`${dslQuestionId}:process`]: body.processText,
  };
  const now = new Date().toISOString();
  const recordId = `quiz-review-${createHash('sha256').update(body.idempotencyKey).digest('hex')}`;

  try {
    const outcome = session.store.transaction(() => {
      const attempt = session.store.submitAttempt({
        projectId: session.projectId,
        questionId: body.questionId,
        idempotencyKey: body.idempotencyKey,
        actorType: 'human_learner',
        answerText: body.answerText,
        processText: body.processText,
        kind: 'real',
      });
      if (attempt.deduplicated) {
        throw new RuntimeHttpError(409, 'VERSION_CONFLICT', 'Attempt exists without its transactional quiz receipt');
      }
      if (attempt.attempt.kind !== 'real') {
        throw new RuntimeHttpError(403, 'SIMULATION_WRITE_FORBIDDEN', 'This quiz submission is not eligible for本人记录');
      }
      const correct = body.answerText === expectedChoice;
      if (attempt.attempt.masteryAfter !== null &&
          (attempt.attempt.masteryAfter === 'passed') !== correct) {
        throw new RuntimeHttpError(409, 'QUESTION_SCORING_MISMATCH', 'Runtime grading disagrees with the stored answer key');
      }
      const payload = {
        payloadVersion: 1,
        phase: 'reviewed' as const,
        answers,
        results: [{
          questionId: dslQuestionId,
          correct,
          status: correct === true ? 'correct' as const : 'incorrect' as const,
          earned: correct === true ? numericPoints(dslQuestion?.['points']) : 0,
        }],
      };
      const recordInput = {
        id: recordId,
        sessionId: body.sessionId,
        sceneId: body.sceneId,
        subAnchor: dslQuestionId,
        createdAt: now,
        payload,
      };
      const validation = validateRuntimeRecord({ ...recordInput, seq: 0 });
      if (!validation.valid) {
        throw new RuntimeHttpError(500, 'INTERNAL_ERROR', 'Server-generated quiz review failed validation', { errors: validation.errors });
      }
      const current = revalidateRuntimeScope(headerScope);
      const currentRuntime = getOwnedSession(current, body.sessionId);
      if (currentRuntime.status !== 'active' || currentRuntime.updatedAt !== runtimeSession.updatedAt) {
        throw new RuntimeHttpError(409, 'VERSION_CONFLICT', 'Quiz runtime session changed while the answer was being scored');
      }
      const record = current.store.runtime.appendRecord(current.projectId, recordInput, {
        expectedLastSeq: body.expectedLastSeq,
        sessionTransition: { status: 'completed', updatedAt: now },
      });
      current.store.runtime.saveQuizReceipt(current.projectId, {
        idempotencyKey: body.idempotencyKey,
        sessionId: body.sessionId,
        questionId: body.questionId,
        recordId,
        createdAt: now,
      });
      return { attempt: toAttemptDto(attempt.attempt), record, deduplicated: false };
    });
    return response({ ok: true, data: { ...outcome, record: recordDto(outcome.record) } });
  } catch (caught) {
    if (caught instanceof RuntimeAppendConflict) {
      throw new RuntimeAppendConflictError(caught.sessionId, caught.expectedLastSeq, caught.actualLastSeq);
    }
    throw caught;
  }
}

function dslQuestionListMismatch(questionList: unknown, dslQuestionId: string, expectedStem: string): boolean {
  if (!Array.isArray(questionList)) return true;
  const matches = questionList.filter((item) => item && typeof item === 'object' && (item as Record<string, unknown>)['id'] === dslQuestionId);
  if (matches.length !== 1) return true;
  const item = matches[0] as Record<string, unknown>;
  return item['question'] !== expectedStem && item['stem'] !== expectedStem;
}

function singleChoiceAnswer(question: Record<string, unknown>): string | null {
  if (question['type'] !== 'single') return null;
  const options = question['options'];
  const answer = question['answer'];
  if (!Array.isArray(options) || options.length < 2 || !Array.isArray(answer) || answer.length !== 1) return null;
  const values = options.flatMap((option) => {
    if (!option || typeof option !== 'object') return [];
    const value = (option as Record<string, unknown>)['value'];
    return typeof value === 'string' ? [value] : [];
  });
  if (values.length !== options.length || new Set(values).size !== values.length) return null;
  const key = answer[0];
  if (typeof key !== 'string') return null;
  if (values.includes(key)) return key;
  const labels = options.flatMap((option) => {
    if (!option || typeof option !== 'object') return [];
    const candidate = option as Record<string, unknown>;
    return candidate['label'] === key && typeof candidate['value'] === 'string' ? [candidate['value']] : [];
  });
  return labels.length === 1 ? labels[0]! : null;
}

function numericPoints(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 1;
}
