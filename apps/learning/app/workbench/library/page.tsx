import type { ReactNode } from 'react';
import { LessonLibrary } from '../../../components/lesson-library';
import { requireSession } from '../../../lib/server/service';
import type { LibraryDocumentDto, LibraryFolderDto } from '../../../lib/document-library';

export const dynamic = 'force-dynamic';

/**
 * 课程库（OMA-001 / OMA-002）。
 *
 * 列出当前项目分区的课堂文档并按文件夹组织。列表与归属都来自服务端权威存储；
 * 页面读取不登记审核、不写入文档，也不把未发布内容升级成可上课堂。
 * 文件夹与成员归组是组织元数据，改归属不会改写文档内容、来源绑定或审核摘要。
 */
export default function LibraryPage(): ReactNode {
  const session = requireSession();
  const projectId = session.projectId;

  const folderIds = session.store.listClassroomDocumentFolderIds(projectId);
  const folders: LibraryFolderDto[] = session.store
    .listClassroomFolders(projectId)
    .map((folder) => ({ id: folder.id, name: folder.name, order: folder.order }));
  const documents: LibraryDocumentDto[] = session.store
    .listClassroomDocuments(projectId)
    .map((row) => ({
      stageId: row.stageId,
      lessonId: row.lessonId,
      name: row.name,
      description: row.description,
      recordScope: row.recordScope,
      sceneCount: row.sceneCount,
      sourceCount: session.store.listClassroomSceneSources(projectId, row.stageId).size,
      assetCount: session.store.listClassroomAssetBindings(projectId, row.stageId).length,
      folderId: folderIds.get(row.stageId) ?? null,
      updatedAt: Number.isNaN(Date.parse(row.updatedAt)) ? 0 : Date.parse(row.updatedAt),
    }));

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>课程库</h1>
          <p>
            浏览当前项目的课堂文档（场景数、来源与资源绑定、正式/演示范围），并按文件夹组织。
            文件夹只记录归属关系；删除文件夹只取消分组，不会删除文档、来源或审核记录。
          </p>
        </div>
      </div>
      <LessonLibrary
        scope={{ projectId, generation: session.generation }}
        folders={folders}
        documents={documents}
      />
    </div>
  );
}
