import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET as getDocuments } from '../apps/learning/app/api/maic/documents/[[...segments]]/route';
import { GET as getFolders, POST as createFolder } from '../apps/learning/app/api/folders/route';
import { DELETE as deleteFolder, PATCH as renameFolder } from '../apps/learning/app/api/folders/[id]/route';
import { POST as setFolderMember } from '../apps/learning/app/api/folders/members/route';
import { closeProject, getSession, openProjectFromDisk } from '../apps/learning/lib/server/service';
import { ensureFixedLesson, loadRenderableDocument, reviewedLesson } from '../apps/learning/lib/server/classroom-service';
import { classroomDocumentDigest } from '@sew/study-domain';

const request = (path: string, init?: RequestInit): Request => {
  const headers = new Headers(init?.headers);
  const session = getSession();
  if (session) {
    headers.set('x-sew-project-id', session.projectId);
    headers.set('x-sew-generation', String(session.generation));
  }
  return new Request(`http://service.local${path}`, { ...init, headers });
};

const rootContext = { params: Promise.resolve({ segments: [] }) };

describe('课堂文档文件夹合同', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    rootA = mkdtempSync(join(tmpdir(), 'sew-folder-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'sew-folder-b-'));
  });

  afterEach(() => {
    closeProject();
    const holder = (globalThis as { __sewSession?: { environmentBootstrapSuppressed?: boolean } }).__sewSession;
    if (holder) holder.environmentBootstrapSuppressed = false;
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it('创建、重命名、分组和 ungroup 只改组织关系，拒绝 remove 级联删除', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);
    const original = session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId);
    const created = await createFolder(request('/api/folders', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '课堂资料' }),
    }));
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { folder: { id: string; name: string; userKey: string } };
    expect(createdBody.folder).toMatchObject({ name: '课堂资料', userKey: session.projectId });

    const renamed = await renameFolder(request(`/api/folders/${encodeURIComponent(createdBody.folder.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '审核课件' }),
    }), { params: Promise.resolve({ id: createdBody.folder.id }) });
    expect(renamed.status).toBe(200);
    expect((await renamed.json() as { folder: { name: string } }).folder.name).toBe('审核课件');

    const assigned = await setFolderMember(request('/api/folders/members', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageId: reviewedLesson.stageId, folderId: createdBody.folder.id }),
    }));
    expect(assigned.status).toBe(200);
    const summaries = await getDocuments(request('/api/maic/documents'), rootContext);
    expect((await summaries.json() as Array<{ id: string; folderId?: string }>)[0]).toMatchObject({
      id: reviewedLesson.stageId,
      folderId: createdBody.folder.id,
    });

    const refusedRemoval = await deleteFolder(request(`/api/folders/${createdBody.folder.id}?mode=remove`, {
      method: 'DELETE',
    }), { params: Promise.resolve({ id: createdBody.folder.id }) });
    expect(refusedRemoval.status).toBe(403);
    expect(((await refusedRemoval.json()) as { error: { code: string } }).error.code)
      .toBe('FOLDER_DELETE_MODE_UNSUPPORTED');
    expect(session.store.listClassroomFolders(session.projectId)).toHaveLength(1);

    const deleted = await deleteFolder(request(`/api/folders/${createdBody.folder.id}?mode=ungroup`, {
      method: 'DELETE',
    }), { params: Promise.resolve({ id: createdBody.folder.id }) });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, removedStageIds: [] });
    expect(session.store.listClassroomFolders(session.projectId)).toEqual([]);
    const summaryAfter = await getDocuments(request('/api/maic/documents'), rootContext);
    expect((await summaryAfter.json() as Array<{ folderId?: string }>)[0]?.folderId).toBeUndefined();

    const stillRenderable = loadRenderableDocument(session, reviewedLesson.stageId);
    expect(stillRenderable?.digest).toBe(original?.digest);
    expect(classroomDocumentDigest(session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId)?.document))
      .toBe(original?.digest);
  });

  it('项目切换后旧代次失效，其他项目不能认领该文件夹或文档', async () => {
    const sessionA = openProjectFromDisk(rootA);
    ensureFixedLesson(sessionA);
    const created = await createFolder(request('/api/folders', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'A' }),
    }));
    const folderId = ((await created.json()) as { folder: { id: string } }).folder.id;

    const sessionB = openProjectFromDisk(rootB);
    ensureFixedLesson(sessionB);
    const staleRequest = new Request('http://service.local/api/folders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sew-project-id': sessionA.projectId,
        'x-sew-generation': String(sessionA.generation),
      },
      body: JSON.stringify({ name: 'stale' }),
    });
    const stale = await createFolder(staleRequest);
    expect(stale.status).toBe(409);

    const crossProject = await setFolderMember(request('/api/folders/members', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageId: reviewedLesson.stageId, folderId }),
    }));
    expect(crossProject.status).toBe(404);
    expect(sessionB.store.listClassroomDocumentFolderIds(sessionB.projectId).size).toBe(0);
  });

  it('未分组可以幂等清除，未知删除模式显式拒绝', async () => {
    const session = openProjectFromDisk(rootA);
    ensureFixedLesson(session);

    const unfiled = await setFolderMember(request('/api/folders/members', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stageId: 'missing-stage', folderId: null }),
    }));
    expect(unfiled.status).toBe(200);

    const unknownMode = await deleteFolder(request('/api/folders/folder-missing?mode=delete', {
      method: 'DELETE',
    }), { params: Promise.resolve({ id: 'folder-missing' }) });
    expect(unknownMode.status).toBe(400);
    expect(session.store.listClassroomDocuments(session.projectId)).toHaveLength(1);
  });

  it('列表只返回当前项目文件夹，空文件夹也保留', async () => {
    const session = openProjectFromDisk(rootA);
    const created = await createFolder(request('/api/folders', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '空文件夹' }),
    }));
    expect(created.status).toBe(200);
    const listed = await getFolders(request('/api/folders'));
    expect((await listed.json() as { folders: Array<{ name: string }> }).folders.map((folder) => folder.name))
      .toEqual(['空文件夹']);
    expect(session.store.listClassroomDocuments(session.projectId)).toEqual([]);
  });
});
