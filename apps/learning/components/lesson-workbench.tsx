'use client';

import { apiResponses } from '@sew/study-contracts';

/**
 * 课程证据包与课程版本操作台（LESSON-01）。
 *
 * 冻结只接受准入通过的知识点，陈述文本与条件由审核人给定，来源固定取知识点已批准的证据；
 * 修改课程永远产生新的草案版本，发布前服务端再次复核准入。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  CoursewareCandidateDto,
  EvidenceBundleViewDto,
  KnowledgePointDto,
  LessonReviewRecordDto,
  LessonVersionDto,
  QuestionListItemDto,
  ScenePlanDto,
  StatementRevisionCandidateDto,
} from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';
import { FormalInteractionAuthor } from './formal-interaction-author';
import { LessonCoursewareGeneration } from './lesson-courseware-generation';
import { LessonScenePlanEditor } from './lesson-scene-plan-editor';
import { LessonSceneRevision } from './lesson-scene-revision';
import { LessonStatementRevision } from './lesson-statement-revision';

interface StatementRow {
  knowledgeId: string;
  name: string;
  text: string;
  conditions: string;
  include: boolean;
}

/** 每个课程命令的响应合同：界面只消费校验过的数据。 */
const LESSON_RESPONSES = {
  'build-bundle': apiResponses.lessonBundle,
  draft: apiResponses.lessonDraft,
  review: apiResponses.lessonReview,
  publish: apiResponses.lessonPublish,
  withdraw: apiResponses.lessonWithdraw,
  'attach-document': apiResponses.lessonDocument,
} as const;

const STATUS_LABEL: Record<LessonVersionDto['status'], string> = {  draft: '草案',
  published: '已发布',
  superseded: '已被新版本取代',
  withdrawn: '已撤回',
};

const STATUS_TONE: Record<LessonVersionDto['status'], 'verified' | 'pending' | 'info'> = {
  draft: 'pending',
  published: 'verified',
  superseded: 'info',
  withdrawn: 'info',
};

export const LessonWorkbench = ({
  projectId,
  generation,
  bundles,
  lessons,
  versions,
  reviews,
  knowledge,
  questions,
  documents = [],
  statementRevisions = [],
  scenePlans = [],
  coursewareCandidates = [],
  modelConfigured = false,
}: {
  projectId: string;
  generation: number;
  bundles: EvidenceBundleViewDto[];
  lessons: LessonVersionDto[];
  versions: LessonVersionDto[];
  reviews: LessonReviewRecordDto[];
  knowledge: Array<KnowledgePointDto & { admitted: boolean }>;
  questions: QuestionListItemDto[];
  /** 已挂接课件文档的课堂映射：按「课程 + 版本」匹配，新版本必须重新挂接。 */
  documents?: Array<{ lessonId: string; lessonVersion: number; stageId: string; documentDigest: string; sceneIds: string[] }>;
  /** 陈述正文改写候选：按课程 + 版本分组展示，待核的才可处置。 */
  statementRevisions?: StatementRevisionCandidateDto[];
  /** 场景计划：按课程 + 版本取用，草案版本可编辑。 */
  scenePlans?: ScenePlanDto[];
  /** 完整课件生成候选（OMA-006）：待核的才可处置。 */
  coursewareCandidates?: CoursewareCandidateDto[];
  /** 是否已配置模型连接；未配置时改写生成按钮不可用。 */
  modelConfigured?: boolean;
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
  const [reviewNote, setReviewNote] = useState('');
  const [withdrawReason, setWithdrawReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const activeBundle = bundles.find((bundle) => bundle.bundleId === bundleId) ?? null;

  /** 该版本冻结时使用的证据包内容；取不到就没有可逐场景勾选的陈述。 */
  const versionBundle = (lesson: LessonVersionDto) =>
    bundles.find((item) => item.bundleId === lesson.bundleId)?.bundle ?? null;

  const call = async (
    body: { action: keyof typeof LESSON_RESPONSES } & Record<string, unknown>,
    successText: string,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await apiFetch('/api/study/lessons', LESSON_RESPONSES[body.action], {
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

  /**
   * 生成课件文档并挂接课堂映射。
   *
   * 文档内容由服务端从该版本冻结的证据包装配，界面只提交版本编号；
   * 返回的跳过项直接显示，避免「场景变少了」被当成正常结果。
   */
  const attach = async (lessonId: string, version: number): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await apiFetch('/api/study/lessons', apiResponses.lessonDocument, {
        method: 'POST',
        body: JSON.stringify({ scope: { projectId, generation }, action: 'attach-document', lessonId, version }),
      });
      const skipped = result.document.skipped.length > 0
        ? `；${result.document.skipped.length} 项未进入课件：${result.document.skipped[0]!.reason}`
        : '';
      setNote(`v${version} 课件文档已挂接：${result.document.sceneCount} 个场景，`
        + `指纹 ${result.document.digest.slice(0, 12)}…${skipped}`);
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
        <p className="secondary">
          草案须经本地用户审核通过才能发布；审核与发布都会复核准入，来源已失效的版本不能靠点击放行。
          撤回只停用课堂入口，历史版本与证据包摘要保持原样。
        </p>
        {lessons.length === 0 ? (
          <Empty>还没有课程版本。</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>课程</th>
                <th>标题</th>
                <th>状态</th>
                <th>本版本审核</th>
                <th>陈述/题目</th>
                <th>证据包摘要</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((lesson) => {
                const review = reviews.find((item) => item.lessonId === lesson.lessonId && item.version === lesson.version);
                const attached = documents.find((item) => item.lessonId === lesson.lessonId && item.lessonVersion === lesson.version);
                return (
                  <tr key={`${lesson.lessonId}-v${lesson.version}`}>
                    <td className="mono">{lesson.lessonId}</td>
                    <td>{lesson.title}</td>
                    <td>
                      <span className="pill" data-tone={STATUS_TONE[lesson.status]}>
                        {STATUS_LABEL[lesson.status]}
                      </span>
                    </td>
                    <td>
                      {review
                        ? <span className="mono">{review.decision === 'approved' ? '已通过' : '已退回'} · {review.reviewedAt.slice(0, 10)}</span>
                        : <span className="muted">未审核</span>}
                    </td>
                    <td className="mono">
                      {lesson.statementIds.length} / {lesson.questionIds.length}
                    </td>
                    <td className="mono" title={lesson.bundleDigest}>{lesson.bundleDigest.slice(0, 12)}…</td>
                    <td>
                      {lesson.status === 'draft' && !review ? <FormalInteractionAuthor scope={{ projectId, generation }} lessonId={lesson.lessonId} lessonVersion={lesson.version} statements={(bundles.find(b => b.bundleId === lesson.bundleId)?.bundle.statements ?? []).filter(s => lesson.statementIds.includes(s.statementId))} /> : null}
                      <div className="row-inline">
                        {lesson.status === 'draft' ? (
                          <>
                            <button
                              type="button"
                              className="btn"
                              disabled={busy}
                              onClick={() => void call(
                                { action: 'review', lessonId: lesson.lessonId, version: lesson.version, decision: 'approved', note: reviewNote },
                                `课程 ${lesson.lessonId} v${lesson.version} 审核已通过（仅对本版本有效）。`,
                              )}
                            >
                              审核通过
                            </button>
                            <button
                              type="button"
                              className="btn"
                              disabled={busy}
                              onClick={() => void call(
                                { action: 'review', lessonId: lesson.lessonId, version: lesson.version, decision: 'rejected', note: reviewNote },
                                `课程 ${lesson.lessonId} v${lesson.version} 已退回。`,
                              )}
                            >
                              退回
                            </button>
                            {review?.decision === 'approved' ? (
                              <button
                                type="button"
                                className="btn btn-primary"
                                disabled={busy}
                                onClick={() => void call(
                                  { action: 'publish', lessonId: lesson.lessonId, version: lesson.version },
                                  `课程 ${lesson.lessonId} v${lesson.version} 已发布；旧已发布版本转为已被新版本取代。`,
                                )}
                              >
                                发布 v{lesson.version}
                              </button>
                            ) : (
                              <span className="muted">需先审核通过才能发布</span>
                            )}
                          </>
                        ) : null}
                        {lesson.status === 'published' ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={busy}
                              onClick={() => void attach(lesson.lessonId, lesson.version)}
                              title="文档内容由服务端按该版本冻结的证据包装配，来源失效即拒绝挂接"
                            >
                              {attached ? '重新生成课件文档' : '生成课件文档并挂接'}
                            </button>
                            {attached ? (
                              <Link className="btn" href={`/classroom/${lesson.lessonId}`}>
                                进入课堂（{attached.sceneIds.length} 个场景）
                              </Link>
                            ) : (
                              <span className="muted">课件文档未挂接，课堂尚不可用</span>
                            )}
                            <button
                              type="button"
                              className="btn"
                              disabled={busy}
                              onClick={() => void call(
                                { action: 'withdraw', lessonId: lesson.lessonId, reason: withdrawReason },
                                `课程 ${lesson.lessonId} 已撤回，课堂入口随即阻断。`,
                              )}
                            >
                              撤回
                            </button>
                          </>
                        ) : null}
                      </div>
                      {versionBundle(lesson) ? (
                        <LessonSceneRevision
                          key={`${lesson.lessonId}-v${lesson.version}-revise`}
                          bundle={versionBundle(lesson)!}
                          lesson={lesson}
                          busy={busy}
                          onRevise={(nextTitle, statementIds) => void call(
                            {
                              action: 'draft',
                              lessonId: lesson.lessonId,
                              bundleId: lesson.bundleId,
                              title: nextTitle,
                              statementIds,
                              questionIds: lesson.questionIds,
                            },
                            `已从 v${lesson.version} 派生新的草案版本，需重新审核后才会生效；旧版本保持不变。`,
                          )}
                        />
                      ) : null}
                      {versionBundle(lesson) && lesson.status === 'draft' ? (
                        <LessonStatementRevision
                          key={`${lesson.lessonId}-v${lesson.version}-statement-revision`}
                          projectId={projectId}
                          generation={generation}
                          lesson={lesson}
                          bundle={versionBundle(lesson)!}
                          candidates={statementRevisions}
                          configured={modelConfigured}
                        />
                      ) : null}
                      {versionBundle(lesson) ? (
                        <LessonScenePlanEditor
                          key={`${lesson.lessonId}-v${lesson.version}-scene-plan`}
                          projectId={projectId}
                          generation={generation}
                          lesson={lesson}
                          bundle={versionBundle(lesson)!}
                          plan={scenePlans.find(
                            (item) => item.lessonId === lesson.lessonId && item.lessonVersion === lesson.version,
                          ) ?? null}
                          busy={busy}
                          onSaved={setNote}
                        />
                      ) : null}
                      {versionBundle(lesson) && lesson.status === 'draft' ? (
                        <LessonCoursewareGeneration
                          key={`${lesson.lessonId}-v${lesson.version}-courseware`}
                          projectId={projectId}
                          generation={generation}
                          lesson={lesson}
                          bundle={versionBundle(lesson)!}
                          candidates={coursewareCandidates}
                          configured={modelConfigured}
                        />
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="row-inline" style={{ marginTop: 'var(--sew-space-3)' }}>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label htmlFor="lesson-review-note">审核备注</label>
            <input
              id="lesson-review-note"
              value={reviewNote}
              onChange={(event) => setReviewNote(event.target.value)}
              placeholder="例如：陈述与教材第 2 段一致"
            />
          </div>
          <div className="field" style={{ flex: '1 1 260px' }}>
            <label htmlFor="lesson-withdraw-reason">撤回原因</label>
            <input
              id="lesson-withdraw-reason"
              value={withdrawReason}
              onChange={(event) => setWithdrawReason(event.target.value)}
              placeholder="例如：来源版本待更新"
            />
          </div>
        </div>
        <p className="hint">审核备注与撤回原因写入审核记录与课堂映射说明，撤回后仍可核对当时依据。</p>
      </div>
      {note ? <Notice tone="verified">{note}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </>
  );
};
