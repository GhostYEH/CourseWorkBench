/**
 * 课程库（OMA-001 / OMA-002）客户端合同与分组纯函数。
 *
 * `/api/folders` 与 `/api/maic/documents` 沿用上游 DocumentFolderStore / DocumentStore 的
 * **原始载荷**（`{ folders }` / `{ folder }` / `{ ok }` / `{ error }`），不套本项目的
 * `{ ok, data }` 信封（见 docs/code-quality.md 的合同例外）。这里给出与路由一一对应的校验
 * schema，界面只消费校验后的数据，不直接相信网络响应。
 *
 * 分组与筛选都是纯函数，便于脱离渲染器验证；它们不写任何权威状态。
 */

import { z } from 'zod';
import type { RecordScope } from '@sew/study-contracts';

export const documentFolderSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    order: z.number().int(),
    createdAt: z.number(),
    updatedAt: z.number(),
    userKey: z.string().optional(),
  })
  .strict();

export const documentFolderListSchema = z
  .object({ folders: z.array(documentFolderSchema) })
  .strict();
export const documentFolderWriteSchema = z.object({ folder: documentFolderSchema }).strict();
export const folderDeleteResultSchema = z
  .object({ ok: z.literal(true), removedStageIds: z.array(z.string()) })
  .strict();
export const memberWriteResultSchema = z.object({ ok: z.literal(true) }).strict();

export const libraryDocumentSummarySchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    sceneCount: z.number().int().nonnegative(),
    folderId: z.string().optional(),
  })
  .strict();
export const libraryDocumentListSchema = z.array(libraryDocumentSummarySchema);

/** 原始合同错误体：`{ error: { code, message, details? } }`（不套信封）。 */
export const rawApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export interface LibraryFolderDto {
  id: string;
  name: string;
  order: number;
}

export interface LibraryDocumentDto {
  stageId: string;
  lessonId: string;
  name: string;
  description: string;
  recordScope: RecordScope;
  sceneCount: number;
  sourceCount: number;
  assetCount: number;
  folderId: string | null;
  updatedAt: number;
}

export interface LibraryGroupDto {
  folder: LibraryFolderDto | null;
  documents: LibraryDocumentDto[];
}

/** 按文件夹顺序分组，未分组文档单独成组（folder 为 null）。空文件夹保留。 */
export const groupLibraryDocuments = (
  documents: readonly LibraryDocumentDto[],
  folders: readonly LibraryFolderDto[],
): LibraryGroupDto[] => {
  const ordered = [...folders].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return [
    ...ordered.map((folder) => ({
      folder,
      documents: documents.filter((document) => document.folderId === folder.id),
    })),
    { folder: null, documents: documents.filter((document) => document.folderId === null) },
  ];
};

/** 关键字只用于筛选展示，不改变归属；文件夹名命中时保留其全部文档。 */
export const filterLibraryGroups = (
  groups: readonly LibraryGroupDto[],
  query: string,
): LibraryGroupDto[] => {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0)
    return groups.map((group) => ({ folder: group.folder, documents: [...group.documents] }));
  return groups
    .map((group) => {
      const folderMatches =
        group.folder !== null && group.folder.name.toLowerCase().includes(needle);
      const documents = folderMatches
        ? group.documents
        : group.documents.filter(
            (document) =>
              document.name.toLowerCase().includes(needle) ||
              document.description.toLowerCase().includes(needle) ||
              document.stageId.toLowerCase().includes(needle),
          );
      return { folder: group.folder, documents };
    })
    .filter(
      (group) =>
        group.documents.length > 0 ||
        (group.folder !== null && group.folder.name.toLowerCase().includes(needle)),
    );
};
