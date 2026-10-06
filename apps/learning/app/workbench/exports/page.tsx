import type { ReactNode } from 'react';
import { LessonExportPanel } from '../../../components/lesson-export-panel';
import { requireSession } from '../../../lib/server/service';

export const dynamic = 'force-dynamic';

/**
 * 导出（OMA-068/069/070/072）。
 *
 * 只列出当前**已审核发布**的课程版本；导出为自包含 HTML 包（ZIP），写入项目 `exports/`。
 * 未发布/未审核/来源失效/审核后计划已改的版本由服务端整节阻断，页面只显示错误。
 */
export default function ExportsPage(): ReactNode {
  const session = requireSession();
  const projectId = session.projectId;
  const lessons = session.store.listLessons(projectId).flatMap((lesson) => {
    const link = session.store.getLessonClassroomLink(lesson.lessonId, projectId);
    if (!link || link.status !== 'published') return [];
    const version = session.store.getLessonVersion(lesson.lessonId, link.lessonVersion, projectId);
    if (!version) return [];
    return [{ lessonId: version.lessonId, version: version.version, title: version.title }];
  });

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>导出</h1>
          <p>
            把已审核发布的课程版本导出为自包含 HTML 包，写入项目{' '}
            <span className="mono">exports/</span> 目录，随项目备份一起迁移。产物不引用外部 URL
            或本机绝对路径；未内联的离线资源逐项列出。
          </p>
        </div>
      </div>
      <LessonExportPanel projectId={projectId} generation={session.generation} lessons={lessons} />
    </div>
  );
}
