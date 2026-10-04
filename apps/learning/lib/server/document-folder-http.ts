import { NextResponse } from 'next/server';
import { StudyError, type ProjectScope } from '@sew/study-contracts';
import { DocumentOrganizationError } from '@sew/study-storage';
import { mapHttpError } from './http';
import { scopedRequest } from './scoped-request';
import type { Session } from './service';


export interface ScopedDocumentFolderSession {
  session: Session;
  scope: ProjectScope;
}

export const documentFolderScope = (request: Request): ScopedDocumentFolderSession =>
  scopedRequest(request, requiredHeaders => new StudyError('INVALID_ARGUMENT', { requiredHeaders }));

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

    const mapped = mapHttpError(error);
    return rawFolderError(mapped.status, mapped.error.code, mapped.error.message);
  }
};

export const folderJsonError = rawFolderError;

