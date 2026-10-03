import { z } from 'zod';
import { attemptSubmitSchema } from '@sew/study-contracts';
import { parseBody, parseQuery, route, ok } from '../../../../lib/server/http';
import { assertScope, requireSession } from '../../../../lib/server/service';
import { toAttemptDto } from '../../../../lib/server/dto';

export const dynamic = 'force-dynamic';

const attemptsQuerySchema = z.object({
  kind: z.enum(['real', 'simulation']).optional(),
  recordScope: z.enum(['formal', 'demo']).default('formal'),
});

export const GET = route((request: Request) => {
  const session = requireSession();
  const query = parseQuery(request, attemptsQuerySchema);
  const attempts = session.store.listAttempts(query.kind, query.recordScope);
  return ok({ attempts: attempts.map((row) => toAttemptDto(row)) });
});

/**
 * 提交作答。幂等键命中即读取既有收据，不重复写入；
 * AI 同学的提交被强制写入 simulation，不修改本人 attempt / mastery。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, attemptSubmitSchema);
  const session = assertScope(body.scope);

  const result = session.store.submitAttempt({
    projectId: session.projectId,
    questionId: body.questionId,
    idempotencyKey: body.idempotencyKey,
    actorType: body.actorType,
    answerText: body.answerText,
    processText: body.processText,
    kind: body.kind,
  });

  return ok({
    attempt: toAttemptDto(result.attempt, result.deduplicated),
    deduplicated: result.deduplicated,
    forcedSimulation: result.forcedSimulation,
  });
});
