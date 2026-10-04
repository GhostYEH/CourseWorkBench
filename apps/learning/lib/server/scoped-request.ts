import type { ProjectScope } from '@sew/study-contracts';
import { assertScope, requireSession, type Session } from './service';

export const PROJECT_SCOPE_HEADERS = ['x-sew-project-id', 'x-sew-generation'] as const;

/** Authenticate malformed scope requests before returning an adapter-specific validation error. */
export const scopedRequest = (
  request: Request,
  invalid: (requiredHeaders: readonly string[]) => Error,
): { scope: ProjectScope; session: Session } => {
  const projectId = request.headers.get(PROJECT_SCOPE_HEADERS[0]);
  const rawGeneration = request.headers.get(PROJECT_SCOPE_HEADERS[1]);
  const generation = rawGeneration === null ? NaN : Number(rawGeneration);
  if (!projectId || !Number.isSafeInteger(generation) || generation < 1) {
    requireSession();
    throw invalid(PROJECT_SCOPE_HEADERS);
  }
  const scope = { projectId, generation };
  return { scope, session: assertScope(scope) };
};
