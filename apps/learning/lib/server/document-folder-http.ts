import { NextResponse } from 'next/server';
import { StudyError, type ProjectScope } from '@sew/study-contracts';
import { DocumentOrganizationError } from '@sew/study-storage';
import { fail } from './http';
import { assertScope, requireSession, type Session } from './service';

const PROJECT_HEADER = 'x-sew-project-id';
const GENERATION_HEADER = 'x-sew-generation';

export interface ScopedDocumentFolderSession {
  session: Session;
  scope: ProjectScope;
}

export const documentFolderScope = (request: Request): ScopedDocumentFolderSession => {
  const projectId = request.headers.get(PROJECT_HEADER);
  const rawGeneration = request.headers.get(GENERATION_HEADER);
  const generation = rawGeneration === null ? Number.NaN : Number(rawGeneration);
  if (!projectId || !Number.isSafeInteger(generation) || generation < 1) {
    // Authenticate the service first, matching the documents route's missing-scope behavior.
    requireSession();
    throw new StudyError('INVALID_ARGUMENT', {
      requiredHeaders: [PROJECT_HEADER, GENERATION_HEADER],
    });
  }
  const scope = { projectId, generation };
  return { scope, session: assertScope(scope) };
};

const rawFolderError = (
  status: number,
  code: string,
  message: string,
): NextResponse => NextResponse.json({ error: { code, message } }, { status });

export const documentFolderRoute = <Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse> | NextResponse,
) => async (...args: Args): Promise<NextResponse> => {
  try {
    return await handler(...args);
  } catch (error) {
    if (error instanceof DocumentOrganizationError) {
      const mapped = error.kind === 'duplicate'
        ? ['FOLDER_NAME_DUPLICATE', 409]
        : error.kind === 'limit'
          ? ['FOLDER_LIMIT_REACHED', 409]
          : error.kind === 'tooLong'
            ? ['FOLDER_NAME_TOO_LONG', 400]
            : ['FOLDER_NAME_EMPTY', 400];
      return rawFolderError(mapped[1] as number, mapped[0] as string, error.message);
    }

    const mapped = fail(error);
    const payload = await mapped.json() as { error?: { code?: string; message?: string } };
    return rawFolderError(
      mapped.status,
      payload.error?.code ?? 'INTERNAL',
      payload.error?.message ?? 'Folder request failed',
    );
  }
};

export const folderJsonError = rawFolderError;

