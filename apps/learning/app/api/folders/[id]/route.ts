import { NextResponse } from 'next/server';
import { z } from 'zod';
import { parseBody } from '../../../../lib/server/http';
import {
  documentFolderRoute,
  documentFolderScope,
  folderJsonError,
} from '../../../../lib/server/document-folder-http';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };
const renameFolderBody = z.object({ name: z.string() });

const folderResponse = (folder: {
  id: string;
  name: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}, userKey: string) => ({ ...folder, userKey });

/** Rename an organization folder without reading or writing the document. */
export const PATCH = documentFolderRoute(async (request: Request, context: Params) => {
  const { name } = await parseBody(request, renameFolderBody);
  const { id } = await context.params;
  const { session, scope } = documentFolderScope(request);
  const folder = session.store.renameClassroomFolder(scope.projectId, id, name.trim());
  if (!folder) return folderJsonError(404, 'FOLDER_NOT_FOUND', 'folder not found');
  return NextResponse.json({ folder: folderResponse(folder, scope.projectId) });
});

/** Removing a folder always unfiles its documents; cascade deletion is denied. */
export const DELETE = documentFolderRoute(async (request: Request, context: Params) => {
  const { id } = await context.params;
  const { session, scope } = documentFolderScope(request);
  const mode = new URL(request.url).searchParams.get('mode');
  if (mode === 'remove') {
    return folderJsonError(403, 'FOLDER_DELETE_MODE_UNSUPPORTED', 'folder removal cannot delete classroom documents');
  }
  if (mode !== null && mode !== 'ungroup') {
    return folderJsonError(400, 'FOLDER_DELETE_MODE_INVALID', 'mode must be ungroup');
  }
  const deleted = session.store.deleteClassroomFolder(scope.projectId, id);
  if (!deleted) return folderJsonError(404, 'FOLDER_NOT_FOUND', 'folder not found');
  return NextResponse.json({ ok: true, removedStageIds: [] });
});

