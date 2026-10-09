'use client';

/**
 * 课程完成页（OMA-033）。
 *
 * 只读呈现：完成状态只依据本人真实提交，未作答不自动标完成；AI/模拟分区不计入。
 * 数据来自 `/api/study/lessons/completion`（只读，不写任何事实、不更新掌握）。
 */

import { useCallback, useEffect, useState } from 'react';
import { courseCompletionSchema } from '@sew/study-contracts';
import type { CourseCompletionDto } from '@sew/study-contracts';
import { Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

const STATUS_LABEL: Record<CourseCompletionDto['status'], string> = {
  not_started: '未开始',
  in_progress: '进行中',
  completed: '已完成',
};

const KNOWLEDGE_LABEL: Record<
  CourseCompletionDto['knowledge'][number]['status'],
  string
> = {
  not_started: '未开始',
  in_progress: '进行中',
  completed: '已完成',
};

export const CourseCompletionPanel = ({
  projectId,
  generation,
  lessonId,
  version,
}: {
  projectId: string;
  generation: number;
  lessonId: string;
  version: number;
}) => {
  const [data, setData] = useState<CourseCompletionDto | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await apiFetch(
        `/api/study/lessons/completion?projectId=${encodeURIComponent(projectId)}&generation=${generation}&lessonId=${encodeURIComponent(lessonId)}&version=${version}`,
        courseCompletionSchema,
        { cache: 'no-store' },
      );
      setData(result);
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setLoading(false);
    }
  }, [projectId, generation, lessonId, version]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <details className="card" data-course-completion={`${lessonId}:v${version}`}>
      <summary>
        课程完成页（v{version}）：{data ? STATUS_LABEL[data.status] : loading ? '读取中…' : '未读取'}
      </summary>
      <p className="muted">
        完成状态只依据**本人真实提交**：未作答不自动标完成，AI 同学与模拟分区不计入。
        本页只读，不写任何作答、不更新掌握状态。
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {data ? (
        <>
          <div className="row-inline">
            <span className="pill" data-tone={data.status === 'completed' ? 'verified' : 'pending'}>
              {STATUS_LABEL[data.status]}
            </span>
            <span className="muted mono">
              知识点 {data.totals.answeredCount}/{data.totals.questionCount} 题已答 · 正确{' '}
              {data.totals.correctCount} · 待核对反馈 {data.pendingFeedback}
            </span>
          </div>
          {data.knowledge.length === 0 ? (
            <p className="muted">本版本没有绑定知识点。</p>
          ) : (
            <ul className="check-list" data-course-completion-list>
              {data.knowledge.map((item) => (
                <li key={item.knowledgeId} data-completion-knowledge={item.knowledgeId}>
                  <span className="pill">{KNOWLEDGE_LABEL[item.status]}</span>{' '}
                  <span className="mono">{item.knowledgeId}</span> · 已答{' '}
                  {item.answeredCount}/{item.questionCount} · 正确 {item.correctCount}
                  {item.pendingReview ? <span className="muted"> · 含待判分</span> : null}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn" disabled={loading} onClick={() => void load()}>
            重新读取完成度
          </button>
        </>
      ) : null}
    </details>
  );
};
