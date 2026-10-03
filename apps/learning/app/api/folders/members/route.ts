import { NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBody } from '../../../../lib/server/http';
import { documentFolderRoute, documentFolderScope } from '../../../../lib/server/document-folder-http';

export const dynamic = 'force-dynamic';

const membershipBody = z.object({
  stageId: z.string().min(1),
  folderId: z.string().min(1).nullable(),
});

/** Set or clear the project-scoped organization relation for an existing document. */
export const POST = documentFolderRoute(async (request: Request) => {
  const { stageId, folderId } = await parseBody(request, membershipBody);
  const { session, scope } = documentFolderScope(request);
  const updated = session.store.setClassroomDocumentFolder(scope.projectId, stageId, folderId);
  if (!updated) {
    return NextResponse.json({ error: { code: 'FOLDER_NOT_FOUND', message: 'folder or document not found' } }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
});

