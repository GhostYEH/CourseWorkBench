'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { apiResponses } from '@sew/study-contracts';
import { Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';
import { useCommand } from '../lib/use-command';

/**
 * 课件自包含导出（OMA-068/069/070/072）。
 *
 * 只列出当前已审核发布、可上课堂的课程版本。点击导出会真实生成一个 ZIP 包并写入项目
 * `exports/` 目录，界面如实显示：产物相对路径、整包 sha256、包内条目数、未随包内联的
 * 资源缺口。未发布/未审核/来源失效/审核后计划已改的版本由服务端整节阻断，界面只显示错误，
 * 不会产出任何文件。
 */
export const LessonExportPanel = ({
  projectId,
  generation,
  lessons,
}: {
  projectId: string;
  generation: number;
  lessons: Array<{ lessonId: string; version: number; title: string }>;
}): ReactNode => {
  const command = useCommand([projectId, generation, 'lesson-export'].join(':'));
  const { busy, error, setError } = command;
  const [result, setResult] = useState<{
    lessonId: string;
    version: number;
    destination: string;
    fileName: string;
    sha256: string | null;
    byteLength: number;
    entryCount: number;
    unresolvedAssets: string[];
    resourceGaps: string[];
    message: string;
  } | null>(null);

  const run = async (lessonId: string, version: number): Promise<void> => {
    await command.run(
      ({ signal }) =>
        apiFetch('/api/study/lessons/export', apiResponses.lessonExport, {
          method: 'POST',
          signal,
          body: JSON.stringify({
            scope: { projectId, generation },
            action: 'export-lesson',
            lessonId,
            version,
            format: 'html',
          }),
        }),
      {
        onStart: () => setResult(null),
        onSuccess: (data) => {
          const exported = data.export;
          setResult({
            lessonId: exported.lessonId,
            version: exported.lessonVersion,
            destination: exported.destination ?? '',
            fileName: exported.fileName,
            sha256: exported.sha256,
            byteLength: exported.byteLength,
            entryCount: exported.manifest?.entries.length ?? 0,
            unresolvedAssets: exported.unresolvedAssets,
            resourceGaps: (exported.manifest?.resources ?? [])
              .filter((resource) => resource.status === 'missing')
              .map((resource) => resource.reference),
            message: exported.message,
          });
        },
        onError: (caught) => {
          setError(describeApiError(caught));
        },
      },
    );
  };

  return (
    <div className="card">
      <h2>导出课件</h2>
      <p className="secondary">
        把已审核发布的课程版本导出为自包含 HTML 包（ZIP），写入项目{' '}
        <span className="mono">exports/</span> 目录。产物含可离线打开的{' '}
        <span className="mono">index.html</span>、逐条摘要清单与库内图片资源；
        测验答案与判分依据在导出时移除。正式互动的离线运行与提交、可编辑 PowerPoint 与 MP4
        导出尚未实现。
      </p>
      {lessons.length === 0 ? (
        <p className="muted">当前没有已审核发布的课程版本，无法导出。</p>
      ) : (
        <ul className="check-list">
          {lessons.map((lesson) => (
            <li key={`${lesson.lessonId}-v${lesson.version}`}>
              <span>{lesson.title}</span>
              <span className="muted mono">
                {lesson.lessonId} · v{lesson.version}
              </span>
              <button
                type="button"
                className="btn"
                disabled={busy}
                data-lesson-export={`${lesson.lessonId}:${lesson.version}`}
                onClick={() => void run(lesson.lessonId, lesson.version)}
              >
                {busy ? '导出中…' : '导出为自包含 HTML 包'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {result ? (
        <Notice tone="verified" role="status">
          <p>
            已导出 {result.lessonId} v{result.version}：
            <span className="mono">{result.destination}</span>
          </p>
          <p className="muted mono">
            条目 {result.entryCount} · {result.byteLength} 字节 · sha256{' '}
            {result.sha256?.slice(0, 16)}…
          </p>
          {result.unresolvedAssets.length > 0 ? (
            <p className="muted">未随包内联的资源：{result.unresolvedAssets.join('、')}</p>
          ) : null}
          {result.resourceGaps.length > 0 ? (
            <p className="muted">已知离线资源缺口：{result.resourceGaps.join('、')}</p>
          ) : null}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : null}
    </div>
  );
};
