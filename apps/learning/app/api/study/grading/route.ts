import { z } from 'zod';
import { StudyError, attemptGradingCommandSchema } from '@sew/study-contracts';
import { ok, parseBody, parseQuery, route } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';
import { modelConnection } from '../../../../lib/server/model-connection';
import { generateAttemptGradeCandidate } from '../../../../lib/server/attempt-grading-model';

export const dynamic = 'force-dynamic';

const contextQuerySchema = z.object({
  attemptId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  projectId: z.string().min(1),
  generation: z.coerce.number().int().positive(),
}).strict().refine((query) => Boolean(query.attemptId) !== Boolean(query.idempotencyKey), {
  message: '必须指定一份已提交作答。',
});
const uncached = { headers: { 'cache-control': 'no-store' } };

/** Reference answers become available here only for an existing personal submission. */
export const GET = route((request: Request) => {
  const query = parseQuery(request, contextQuerySchema);
  const session = assertScope({ projectId: query.projectId, generation: query.generation });
  const attemptId = query.attemptId ?? session.store.getAttemptByIdempotencyKey(query.idempotencyKey!)?.attemptId;
  const context = attemptId ? session.store.getAttemptGradingContext(session.projectId, attemptId) : null;
  if (!context) throw new StudyError('NOT_FOUND', { reason: 'personal_submission_not_found' });
  return ok(context, uncached);
});

/** Model proposals and explicit human decisions have separate persistence paths. */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, attemptGradingCommandSchema);
  const session = assertScope(body.scope);
  if (body.action === 'generate') {
    const result = await generateAttemptGradeCandidate({
      store: session.store,
      projectId: session.projectId,
      connection: modelConnection,
      revalidateScope: () => { assertScope(body.scope); },
    }, body, request.signal);
    return ok(result, uncached);
  }
  if (body.action === 'reject') {
    return ok(session.store.rejectAttemptGradeCandidate({
      projectId: session.projectId,
      attemptId: body.attemptId,
      expectedReviewVersion: body.expectedReviewVersion,
      requestId: body.requestId,
      candidateId: body.candidateId,
      note: body.note,
    }), uncached);
  }
  return ok(session.store.reviewAttemptGrade({
    projectId: session.projectId,
    attemptId: body.attemptId,
    expectedReviewVersion: body.expectedReviewVersion,
    requestId: body.requestId,
    earned: body.earned,
    basis: body.basis,
    uncertainty: body.uncertainty,
    semanticReviewed: body.semanticReviewed,
    candidateId: body.candidateId,
  }), uncached);
});
