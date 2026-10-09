/**
 * 课件导出服务（OMA-068/069/070/072）。
 *
 * 导出只面向**已审核发布且当前可上**的课程版本：先过 `assertLessonClassroomReady` 的统一复核
 * （发布态、人工审核、来源准入、审核后计划未变），再读取已挂接的权威渲染文档；未发布、
 * 未审核、来源失效或审核后计划已改的版本一律拒绝，不产出任何文件。
 *
 * 产物写入项目内 `exports/`（项目备份已覆盖该目录）：先写临时文件再改名发布，
 * 中途失败不会留下半成品；同名重复导出按最新内容覆盖（导出是可重建的派生视图）。
 */

import { StudyError, type LessonExportResultDto } from '@sew/study-contracts';
import { buildLessonExport, type StudyStore } from '@sew/study-storage';
import type { Session } from './service';
import { loadRenderableFormalDocument } from './classroom-service';
import { publishLessonExport } from './lesson-export-files';

export const exportLesson = (
  session: Session,
  lessonId: string,
  version: number,
): LessonExportResultDto => {
  const projectId = session.projectId;
  const store: StudyStore = session.store;
  // 统一复核：未发布 / 未审核 / 来源失效 / 审核后计划已改都在这里整节阻断。
  const ready = store.assertLessonClassroomReady(lessonId, projectId);
  if (ready.lesson.version !== version) {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'export_lesson_version_not_published',
      requested: version,
      published: ready.lesson.version,
    });
  }
  const renderable = loadRenderableFormalDocument(session, lessonId);
  if (!renderable) {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
      reason: 'export_document_missing',
      lessonId,
    });
  }
  const plan = store.getScenePlan(projectId, lessonId, version);
  const pkg = buildLessonExport({
    store,
    projectId,
    lessonId,
    version,
    title: ready.lesson.title,
    bundleDigest: ready.lesson.bundleDigest,
    plan,
    stageId: renderable.stageId,
    dslVersion: renderable.dslVersion,
    documentDigest: renderable.digest,
    document: renderable.document,
  });

  publishLessonExport(session.displayPath, pkg.fileName, pkg.bytes);

  return {
    projectId,
    lessonId,
    lessonVersion: version,
    format: 'html',
    destination: `exports/${pkg.fileName}`,
    fileName: pkg.fileName,
    byteLength: pkg.bytes.byteLength,
    sha256: pkg.sha256,
    manifest: pkg.manifest,
    unresolvedAssets: pkg.unresolvedAssets,
    message: pkg.unresolvedAssets.length
      ? `已导出 ${pkg.manifest.entries.length} 个条目；有 ${pkg.unresolvedAssets.length} 项资源未随包内联。`
      : `已导出 ${pkg.manifest.entries.length} 个条目。`,
  };
};
