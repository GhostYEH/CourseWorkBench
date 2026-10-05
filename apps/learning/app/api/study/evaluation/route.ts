import { z } from 'zod';
import {
  MAX_EVALUATION_IMPORT_BYTES,
  StudyError,
  projectScopeSchema,
  evaluationReportSchema,
} from '@sew/study-contracts';
import { verifyFrozenEvaluation } from '@sew/study-domain';
import { readBoundedJson, type JsonBodyFailure } from '../../../../lib/server/bounded-json';
import { ok, route } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';

export const dynamic = 'force-dynamic';
const requestSchema = z.object({ scope: projectScopeSchema, frozen: z.unknown() }).strict();

const decodeFailure = (reason: JsonBodyFailure, detail?: string): StudyError =>
  reason === 'too_large'
    ? new StudyError('INVALID_ARGUMENT', { reason: 'evaluation_import_too_large' })
    : reason === 'missing'
      ? new StudyError('INVALID_ARGUMENT')
      : new StudyError('INVALID_ARGUMENT', {
          reason: 'invalid_evaluation_json',
          ...(detail ? { error: detail } : {}),
        });

const boundedJson = (request: Request): Promise<unknown> =>
  readBoundedJson(request, MAX_EVALUATION_IMPORT_BYTES, decodeFailure);

/** Verifies an explicitly selected report; never reads a filesystem path or writes project records. */
export const POST = route(async (request: Request) => {
  const body = requestSchema.safeParse(await boundedJson(request));
  if (!body.success) throw new StudyError('INVALID_ARGUMENT');
  assertScope(body.data.scope);
  let report;
  try {
    report = evaluationReportSchema.parse(verifyFrozenEvaluation(body.data.frozen).report);
  } catch {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'evaluation_digest_or_contract_invalid' });
  }
  assertScope(body.data.scope);
  return ok(report, { headers: { 'cache-control': 'no-store' } });
});
