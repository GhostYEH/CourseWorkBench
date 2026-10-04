'use client';

/**
 * 课程证据包与课程版本操作台（LESSON-01）。
 *
 * 冻结只接受准入通过的知识点，陈述文本与条件由审核人给定，来源固定取知识点已批准的证据；
 * 修改课程永远产生新的草案版本，发布前服务端再次复核准入。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type {
  EvidenceBundleViewDto,
  KnowledgePointDto,
  LessonVersionDto,
  QuestionListItemDto,
} from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

interface StatementRow {
  knowledgeId: string;
  name: string;
  text: string;
  conditions: string;
  include: boolean;
}

export const LessonWorkbench = ({
  projectId,
  generation,
  bundles,
  lessons,
  versions,
  knowledge,
  questions,
}: {
  projectId: string;
  generation: number;
  bundles: EvidenceBundleViewDto[];
  lessons: LessonVersionDto[];
  versions: LessonVersionDto[];
  knowledge: Array<KnowledgePointDto & { admitted: boolean }>;
  questions: QuestionListItemDto[];
}): ReactNode => {
  const router = useRouter();
  const [rows, setRows] = useState<StatementRow[]>(() =>
    knowledge
      .filter((point) => point.admitted)
      .map((point) => ({
        knowledgeId: point.knowledgeId,
        name: point.name,
        text: point.concept,
        conditions: point.conditions,
        include: true,
      })),
  );
  const [questionIds, setQuestionIds] = useState<string[]>([]);
  const [bundleId, setBundleId] = useState(bundles[0]?.bundleId ?? '');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const activeBundle = bundles.find((bundle) => bundle.bundleId === bundleId) ?? null;

  const call = async (body: Record<string, unknown>, successText: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await apiFetch('/api/study/lessons', {
        method: 'POST',
        body: JSON.stringify({ scope: { projectId, generation }, ...body }),
      });
      setNote(successText);
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  const freeze = (): void => {
    const statements = rows
      .filter((row) => row.include)
      .map((row) => ({ knowledgeId: row.knowledgeId, text: row.text, conditions: row.conditions }));
    if (statements.length === 0) {
      setError('至少选择一条学科陈述；没有准入知识点时请先完成候选审核。');
      return;
    }
    void call({ action: 'build-bundle', statements, questionIds }, '证据包已冻结（同一内容重复冻结会复用既有摘要）。');
  };

  const draft = (): void => {
    if (!activeBundle) {
      setError('请先冻结一个证据包。');
      return;
    }
    if (title.trim().length < 2) {
      setError('请填写课程标题。');
      return;
    }
    void call(
      {
        action: 'draft',
        lessonId: null,
        bundleId: activeBundle.bundleId,
        title,
        statementIds: activeBundle.bundle.statements.map((statement) => statement.statementId),
        questionIds,
      },
      '课程草案版本已创建。',
    );
  };

  return (
    <>
      <div className="card">
        <h2>冻结课程证据包</h2>
        <p className="secondary">
          证据包冻结计划版本、知识清单版本、材料与段落摘要、允许的陈述与条件、题目与答案版本，
          以及教学偏好与角色配置摘要。陈述的来源固定取该知识点已批准的证据，不能在这里临时指定段落。
        </p>
        {rows.length === 0 ? (
          <Empty>没有准入通过的知识点，无法冻结证据包。</Empty>
        ) : (
          rows.map((row, index) => (
            <div className="row-inline" key={row.knowledgeId}>
              <label className="secondary" style={{ flex: '0 0 160px' }}>
                <input
                  type="checkbox"
                  checked={row.include}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((item, position) => (position === index ? { ...item, include: event.target.checked } : item)),
                    )
                  }
                  disabled={busy}
                />{' '}
                {row.name}
              </label>
              <div className="field" style={{ flex: '1 1 300px' }}>
                <label htmlFor={`statement-${row.knowledgeId}`}>陈述</label>
                <input
                  id={`statement-${row.knowledgeId}`}
                  value={row.text}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((item, position) => (position === index ? { ...item, text: event.target.value } : item)),
                    )
                  }
                />
              </div>
              <div className="field" style={{ flex: '1 1 240px' }}>
                <label htmlFor={`conditions-${row.knowledgeId}`}>适用条件</label>
                <input
                  id={`conditions-${row.knowledgeId}`}
                  value={row.conditions}
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((item, position) => (position === index ? { ...item, conditions: event.target.value } : item)),
                    )
                  }
                />
              </div>
            </div>
          ))
        )}
        <div className="field">
          <label htmlFor="bundle-questions">随包题目（可选）</label>
          <select
            id="bundle-questions"
            multiple
            value={questionIds}
            onChange={(event) => setQuestionIds([...event.target.selectedOptions].map((option) => option.value))}
            disabled={questions.length === 0 || busy}
          >
            {questions.map((question) => (
              <option key={question.questionId} value={question.questionId}>
                {question.originLabel} · {question.stem.slice(0, 28)}
              </option>
            ))}
          </select>
          <span className="hint">题目只能引用包内知识点；引用包外知识点的题目会被拒绝冻结。</span>
        </div>
        <button type="button" className="btn btn-primary" onClick={freeze} disabled={busy || rows.length === 0}>
          冻结证据包
        </button>
      </div>

      <div className="card">
        <h2>已冻结证据包（{bundles.length}）</h2>
        {bundles.length === 0 ? (
          <Empty>还没有证据包。</Empty>
        ) : (
          <ul>
            {bundles.map((bundle) => (
              <li key={bundle.bundleId}>
                <label className="secondary">
                  <input
                    type="radio"
                    name="bundle"
                    checked={bundleId === bundle.bundleId}
                    onChange={() => setBundleId(bundle.bundleId)}
                    disabled={busy}
                  />{' '}
                  <span className="mono">{bundle.digest.slice(0, 12)}…</span> · 计划 v{bundle.bundle.planVersion} ·
                  {' '}{bundle.bundle.statements.length} 条陈述 · {bundle.bundle.questions.length} 道题 ·
                  段落 {bundle.bundle.segmentDigests.length} 处摘要
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="row-inline">
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label htmlFor="lesson-title">课程标题</label>
            <input id="lesson-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：函数单调性（第 1 课时）" />
          </div>
          <button type="button" className="btn" onClick={draft} disabled={busy || activeBundle === null}>
            创建课程草案
          </button>
        </div>
      </div>

      <div className="card">
        <h2>课程版本</h2>
        {lessons.length === 0 ? (
          <Empty>还没有课程版本。</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>课程</th>
                <th>标题</th>
                <th>状态</th>
                <th>陈述/题目</th>
                <th>证据包摘要</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {lessons.map((lesson) => (
                <tr key={`${lesson.lessonId}-v${lesson.version}`}>
                  <td className="mono">{lesson.lessonId}</td>
                  <td>{lesson.title}</td>
                  <td>
                    <span className="pill" data-tone={lesson.status === 'published' ? 'verified' : lesson.status === 'draft' ? 'pending' : 'info'}>
                      {lesson.status === 'published' ? '已发布' : lesson.status === 'draft' ? '草案' : '已被新版本取代'}
                    </span>
                  </td>
                  <td className="mono">
                    {lesson.statementIds.length} / {lesson.questionIds.length}
                  </td>
                  <td className="mono" title={lesson.bundleDigest}>{lesson.bundleDigest.slice(0, 12)}…</td>
                  <td>
                    {lesson.status === 'draft' ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() =>
                          void call(
                            { action: 'publish', lessonId: lesson.lessonId, version: lesson.version },
                            `课程 ${lesson.lessonId} v${lesson.version} 已发布；旧已发布版本转为已取代。`,
                          )
                        }
                      >
                        发布 v{lesson.version}
                      </button>
                    ) : (
                      <span className="muted">{versions.filter((item) => item.lessonId === lesson.lessonId).length} 个版本</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">发布后修改课程会得到新的草案版本；已发布版本与其证据包摘要保持不变。</p>
      </div>
      {note ? <Notice tone="verified">{note}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </>
  );
};
