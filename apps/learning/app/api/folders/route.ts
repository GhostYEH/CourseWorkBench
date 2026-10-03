import { NextResponse } from 'next/server';
import { newId } from '@sew/study-contracts';
import { DocumentOrganizationError } from '@sew/study-storage';
import { z } from 'zod';
import { parseBody } from '../../../lib/server/http';
import {
  documentFolderRoute,
  documentFolderScope,
} from '../../../lib/server/document-folder-http';

export const dynamic = 'force-dynamic';

const createFolderBody = z.object({ name: z.string() });

const folderResponse = (folder: {
  id: string;
  name: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}, userKey: string) => ({ ...folder, userKey });

/** Project-scoped counterpart of OpenMAIC's GET /api/folders. */
export const GET = documentFolderRoute((request: Request) => {
  const { session, scope } = documentFolderScope(request);
  return NextResponse.json({
    folders: session.store.listClassroomFolders(scope.projectId)
      .map((folder) => folderResponse(folder, scope.projectId)),
  });
});

/** Create one empty organization folder; duplicate names remain a visible conflict. */
export const POST = documentFolderRoute(async (request: Request) => {
  const { name } = await parseBody(request, createFolderBody);
  const trimmed = name.trim();
  const { scope } = documentFolderScope(request);
  const session = documentFolderScope(request).session;
  const existing = session.store.listClassroomFolders(scope.projectId);
  if (existing.some((folder) => folder.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new DocumentOrganizationError('A folder with this name already exists', 'duplicate');
  }
  const created = session.store.createClassroomFolder(
    scope.projectId,
    newId<'folder'>('folder'),
    trimmed,
  );
  if (created.reused) {
    throw new DocumentOrganizationError('A folder with this name already exists', 'duplicate');
  }
  const persisted = session.store.listClassroomFolders(scope.projectId)
    .find((folder) => folder.id === created.folder.id);
  if (!persisted) throw new Error('Created folder could not be read back');
  return NextResponse.json({ folder: folderResponse(persisted, scope.projectId) });
});

