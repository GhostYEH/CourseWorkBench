'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { ProjectScope } from '@sew/study-contracts';
import { z } from 'zod';
import { Notice } from './ui';
import { projectScopeHeaders } from '../lib/client';
import { useCommand } from '../lib/use-command';
import {
  documentFolderWriteSchema,
  folderDeleteResultSchema,
  filterLibraryGroups,
  groupLibraryDocuments,
  memberWriteResultSchema,
  rawApiErrorSchema,
  type LibraryDocumentDto,
  type LibraryFolderDto,
} from '../lib/document-library';

/**
 * 课程库浏览与组织（OMA-001 / OMA-002）。
 *
 * 只做**组织元数据**：文件夹的创建/重命名/取消分组与文档归组，绝不改写文档内容、来源绑定、
 * 审核摘要或课堂状态（这些由服务端保证）。列表来自服务端读取的权威存储，写入走
 * `/api/folders` 与 `/api/maic/documents` 的**上游原始合同**（不是 `{ ok, data }` 信封），
 * 因此这里用受控的原始请求，而不是 apiFetch。
 */
export const LessonLibrary = ({
  scope,
  folders,
  documents,
}: {
  scope: ProjectScope;
  folders: LibraryFolderDto[];
  documents: LibraryDocumentDto[];
}): ReactNode => {
  const router = useRouter();
  const command = useCommand([scope.projectId, scope.generation, 'lesson-library'].join(':'));
  const { busy, error, setError } = command;
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [newFolder, setNewFolder] = useState('');

  const groups = useMemo(
    () => filterLibraryGroups(groupLibraryDocuments(documents, folders), query),
    [documents, folders, query],
  );
  const unfiledCount = documents.filter((document) => document.folderId === null).length;

  /** 原始合同请求：校验失败或错误体一律转成可读提示，不把未校验数据写进视图。 */
  const rawRequest = async <S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    init: RequestInit,
  ): Promise<z.infer<S>> => {
    const response = await fetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...projectScopeHeaders(scope),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('服务响应不是有效 JSON，请刷新后重试');
    }
    if (!response.ok) {
      const parsed = rawApiErrorSchema.safeParse(body);
      throw new Error(
        parsed.success
          ? `${parsed.data.error.code}：${parsed.data.error.message}`
          : `请求失败（HTTP ${response.status}）`,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Error('服务响应与课程库合同不一致，请刷新后重试');
    return parsed.data;
  };

  const run = (operation: () => Promise<void>, successText: string): void => {
    void command.run(
      async () => {
        await operation();
      },
      {
        onStart: () => setNote(null),
        onSuccess: () => {
          setNote(successText);
          router.refresh();
        },
        onError: (caught) => setError(caught instanceof Error ? caught.message : String(caught)),
      },
    );
  };

  const createFolder = (): void => {
    const name = newFolder.trim();
    if (name.length === 0) {
      setError('请填写文件夹名称。');
      return;
    }
    run(async () => {
      await rawRequest('/api/folders', documentFolderWriteSchema, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setNewFolder('');
    }, `已创建文件夹「${name}」。`);
  };

  const renameFolder = (folderId: string, name: string): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('文件夹名称不能为空。');
      return;
    }
    run(async () => {
      await rawRequest(`/api/folders/${encodeURIComponent(folderId)}`, documentFolderWriteSchema, {
        method: 'PATCH',
        body: JSON.stringify({ name: trimmed }),
      });
    }, '已重命名文件夹。');
  };

  const deleteFolder = (folderId: string): void => {
    run(async () => {
      await rawRequest(
        `/api/folders/${encodeURIComponent(folderId)}?mode=ungroup`,
        folderDeleteResultSchema,
        {
          method: 'DELETE',
        },
      );
    }, '已取消分组：文件夹删除但文档内容保持不变。');
  };

  const assignFolder = (stageId: string, folderId: string | null): void => {
    run(
      async () => {
        await rawRequest('/api/folders/members', memberWriteResultSchema, {
          method: 'POST',
          body: JSON.stringify({ stageId, folderId }),
        });
      },
      folderId === null ? '已移出文件夹。' : '已归入文件夹。',
    );
  };

  return (
    <div data-lesson-library>
      <div className="card">
        <div className="row-inline">
          <div className="field" style={{ flex: '1 1 240px' }}>
            <label htmlFor="library-search">筛选（名称 / 描述 / 文档编号）</label>
            <input
              id="library-search"
              value={query}
              disabled={busy}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入关键字缩小列表；不改变归属"
            />
          </div>
          <div className="field" style={{ flex: '1 1 240px' }}>
            <label htmlFor="library-new-folder">新建文件夹</label>
            <input
              id="library-new-folder"
              value={newFolder}
              disabled={busy}
              onChange={(event) => setNewFolder(event.target.value)}
              placeholder="例如：已发布课件"
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-library-create-folder
            onClick={createFolder}
          >
            新建文件夹
          </button>
        </div>
        <p className="hint">
          组织操作只改归属关系：不改写文档内容、来源绑定、审核摘要或课堂状态。删除文件夹只取消分组，
          不删除任何文档。
        </p>
      </div>

      {documents.length === 0 ? (
        <div className="card">
          <h2>课程库</h2>
          <p className="muted">还没有可组织的课堂文档。先在课程页生成并挂接课件文档。</p>
        </div>
      ) : null}

      {groups.map((group) => (
        <div
          className="card"
          key={group.folder?.id ?? 'unfiled'}
          data-library-folder={group.folder?.id ?? 'unfiled'}
        >
          <h2>
            {group.folder ? group.folder.name : `未分组（${unfiledCount}）`}
            <span className="muted mono" style={{ marginLeft: 'var(--sew-space-2)' }}>
              {group.documents.length} 项
            </span>
          </h2>
          {group.folder ? (
            <div className="row-inline">
              <div className="field" style={{ flex: '1 1 220px' }}>
                <label htmlFor={`rename-${group.folder.id}`}>重命名</label>
                <input
                  id={`rename-${group.folder.id}`}
                  defaultValue={group.folder.name}
                  disabled={busy}
                  onBlur={(event) => {
                    if (event.target.value.trim() !== group.folder!.name)
                      renameFolder(group.folder!.id, event.target.value);
                  }}
                />
              </div>
              <button
                type="button"
                className="btn"
                disabled={busy}
                data-library-delete-folder={group.folder.id}
                onClick={() => deleteFolder(group.folder!.id)}
              >
                删除文件夹（仅取消分组）
              </button>
            </div>
          ) : null}
          {group.documents.length === 0 ? (
            <p className="muted">（空文件夹，可重启读回）</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>文档</th>
                  <th>范围</th>
                  <th>场景</th>
                  <th>来源/资源</th>
                  <th>归属</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {group.documents.map((document) => (
                  <tr key={document.stageId} data-library-document={document.stageId}>
                    <td>
                      <div>{document.name || '（未命名文档）'}</div>
                      <div className="muted mono">
                        {document.stageId}
                        {document.lessonId ? ` · ${document.lessonId}` : ''}
                      </div>
                    </td>
                    <td>
                      <span
                        className="pill"
                        data-tone={document.recordScope === 'formal' ? 'verified' : 'info'}
                      >
                        {document.recordScope === 'formal' ? '正式' : '演示'}
                      </span>
                    </td>
                    <td className="mono">{document.sceneCount}</td>
                    <td className="mono">
                      {document.sourceCount} / {document.assetCount}
                    </td>
                    <td>
                      <select
                        value={document.folderId ?? ''}
                        disabled={busy}
                        data-library-assign={document.stageId}
                        onChange={(event) =>
                          assignFolder(document.stageId, event.target.value || null)
                        }
                      >
                        <option value="">未分组</option>
                        {folders.map((folder) => (
                          <option key={folder.id} value={folder.id}>
                            {folder.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {document.lessonId ? (
                        <a
                          className="btn"
                          href={`/classroom/${encodeURIComponent(document.lessonId)}`}
                        >
                          进入课堂
                        </a>
                      ) : (
                        <span className="muted">未关联课程</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}

      {note ? <Notice tone="verified">{note}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
};
