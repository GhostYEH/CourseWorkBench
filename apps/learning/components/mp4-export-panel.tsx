'use client';
import { useEffect, useRef, useState } from 'react';
import { apiResponses, type Mp4TaskDto } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';
import { fetchVerifiedArtifact } from '../lib/verified-artifact';
import { Notice } from './ui';
import { createDirectorResponseGate } from '../lib/director-response-gate';

export function Mp4ExportPanel({
  projectId,
  generation,
  lessons,
}: {
  projectId: string;
  generation: number;
  lessons: Array<{ lessonId: string; version: number; title: string }>;
}) {
  const [tasks, setTasks] = useState<Mp4TaskDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(new Map<string, string>());
  const gate = useRef(createDirectorResponseGate());
  const lifetime = useRef<AbortController | null>(null);
  const query = new URLSearchParams({ projectId, generation: String(generation) }).toString();
  const scope = { projectId, generation };
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const ticket = gate.current.beginRead();
      try {
        const result = await apiFetch(`/api/study/lessons/mp4?${query}`, apiResponses.mp4Tasks, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted && gate.current.acceptsRead(ticket)) setTasks(result.tasks);
      } catch (caught) {
        if (!controller.signal.aborted) setError(describeApiError(caught));
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);
  const mutate = async (body: unknown) => {
    if (busy) return;
    const ticket = gate.current.beginCommand();
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch('/api/study/lessons/mp4', apiResponses.mp4Task, {
        method: 'POST',
        signal: lifetime.current?.signal,
        body: JSON.stringify(body),
      });
      if (!lifetime.current?.signal.aborted && gate.current.commitCommand(ticket))
        setTasks((previous) => [
          result.task,
          ...previous.filter((task) => task.job.jobId !== result.task.job.jobId),
        ]);
    } catch (caught) {
      if (!lifetime.current?.signal.aborted) setError(describeApiError(caught));
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false);
    }
  };
  const download = async (task: Mp4TaskDto) => {
    if (!task.result || busy) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        projectId,
        generation: String(generation),
        lessonId: task.result.lessonId,
        version: String(task.result.lessonVersion),
        format: 'mp4',
        sha256: task.result.sha256,
      });
      const blob = await fetchVerifiedArtifact(`/api/study/lessons/export/download?${params}`, {
        sha256: task.result.sha256,
        byteLength: task.result.byteLength,
        mime: 'video/mp4',
        signal: lifetime.current?.signal,
      });
      if (lifetime.current?.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = task.result.fileName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (caught) {
      if (!lifetime.current?.signal.aborted) setError(describeApiError(caught));
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className="card" data-mp4-export-panel>
      <h2>MP4 视频任务</h2>
      <p className="muted">
        导出已发布幻灯片和测验题面的静音线性视频；互动、PBL
        和授课音轨尚不支持。缺少编码或浏览器运行时会列出阻断原因。停止等待或离开页面不会取消持久任务，请使用“取消任务”。
      </p>
      {lessons.map((lesson) => (
        <button
          type="button"
          className="btn"
          disabled={busy}
          key={`${lesson.lessonId}:${lesson.version}`}
          onClick={() => {
            const id = `${lesson.lessonId}:${lesson.version}`;
            if (!pending.current.has(id)) pending.current.set(id, crypto.randomUUID());
            void mutate({
              scope,
              requestId: pending.current.get(id),
              lessonId: lesson.lessonId,
              version: lesson.version,
            });
          }}
        >
          导出 / 读回 {lesson.title} v{lesson.version}
        </button>
      ))}
      <button type="button" className="btn" disabled={busy} onClick={() => pending.current.clear()}>
        准备新的导出请求
      </button>
      {tasks.map((task) => (
        <article className="card" key={task.job.jobId}>
          <p>
            {task.plan.identity.title} v{task.plan.identity.lessonVersion} · {task.job.state} ·
            已捕获 {task.job.completedSegments.length}/{task.plan.segments.length} 个场景
          </p>
          {task.job.failure ? <p>{task.job.failure.message}</p> : null}
          {['queued', 'preparing', 'capturing', 'encoding', 'blocked'].includes(task.job.state) ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void mutate({
                  scope,
                  jobId: task.job.jobId,
                  action: 'cancel',
                  expectedRevision: task.revision,
                })
              }
            >
              取消任务
            </button>
          ) : null}
          {['failed', 'blocked'].includes(task.job.state) ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void mutate({
                  scope,
                  jobId: task.job.jobId,
                  action: 'resume',
                  expectedRevision: task.revision,
                })
              }
            >
              复验并继续
            </button>
          ) : null}
          {task.result ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void download(task)}
            >
              下载并核验 MP4
            </button>
          ) : null}
        </article>
      ))}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </section>
  );
}
