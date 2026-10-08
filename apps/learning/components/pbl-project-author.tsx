'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import {
  pblFrozenSchema,
  pblProjectDefinitionSchema,
  type PblFrozenDto,
  type PblProjectDefinitionDto,
} from '@sew/study-contracts';
import type { BundleStatementDto } from '@sew/study-contracts';
import { apiFetch, describeApiError, projectScopeHeaders } from '../lib/client';
import { Notice } from './ui';

const makeTemplate = (
  lesson: { lessonId: string; version: number; title: string; statementIds: string[] },
  uid: string,
): PblProjectDefinitionDto => {
  const suffix = `${lesson.lessonId}-v${lesson.version}`
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 60);
  const statementIds = lesson.statementIds.slice(0, 24);
  const taskId = `task-${suffix}`;
  const milestoneId = `milestone-${suffix}`;
  const goalId = `goal-${suffix}`;
  const rubricId = `rubric-${suffix}`;
  return {
    id: `pbl-${suffix}`,
    title: `${lesson.title} 项目学习`,
    statementIds,
    authenticContext: {
      audience: '请填写真实服务对象',
      problem: '请填写需要解决的真实问题',
      constraints: ['请填写一项真实约束'],
    },
    background: '请补充项目背景与真实情境。',
    goals: [
      {
        id: goalId,
        statement: '围绕本版本陈述完成一项真实交付。',
        successDescription: '提交的产物满足公开任务检查。',
      },
    ],
    projectChecks: [],
    roles: [
      {
        id: `learner-${suffix}`,
        name: '本人学习者',
        kind: 'learner',
        responsibilities: ['完成并提交本人项目产物。'],
        memberUid: uid,
      },
      {
        id: `mentor-${suffix}`,
        name: 'AI 导师',
        kind: 'mentor',
        responsibilities: ['针对本人提交的产物给出候选指导。'],
        memberUid: null,
      },
    ],
    tasks: [
      {
        id: taskId,
        title: '提交项目成果',
        statementIds,
        phase: '制作',
        outcome: '提交可供核对的项目成果。',
        artifactKinds: ['report'],
        roleIds: [`learner-${suffix}`],
        checks: [
          {
            id: `check-${suffix}`,
            label: '提交项目报告',
            expectation: '本人提交一份非空项目报告。',
            kind: 'deliverable_submitted',
            artifactKind: 'report',
          },
        ],
        milestoneIds: [milestoneId],
      },
    ],
    milestones: [
      {
        id: milestoneId,
        title: '完成首个成果',
        statementIds,
        order: 1,
        checks: [
          {
            id: `milestone-check-${suffix}`,
            label: '任务成果已提交',
            expectation: '本人已提交项目报告。',
            kind: 'deliverable_submitted',
            artifactKind: 'report',
          },
        ],
        rubricIds: [rubricId],
        taskIds: [taskId],
      },
    ],
    rubrics: [
      {
        id: rubricId,
        criterion: '成果的完整性',
        levels: [
          { level: 'exemplary', descriptor: '成果完整且依据清晰。' },
          { level: 'adequate', descriptor: '成果基本满足要求。' },
          { level: 'developing', descriptor: '成果仍需补充。' },
        ],
      },
    ],
    cadenceDays: null,
  };
};

const authorReadSchema = z.union([
  z.object({ frozen: pblFrozenSchema, digest: z.string().min(1) }).strict(),
  z.null(),
]);

export function PblProjectAuthor({
  projectId,
  generation,
  lesson,
  learnerUid,
  statements = [],
  frozen: initialFrozen = null,
  onFrozen,
}: {
  projectId: string;
  generation: number;
  lesson: { lessonId: string; version: number; title: string; statementIds: string[] };
  learnerUid: string;
  statements?: BundleStatementDto[];
  frozen?: PblFrozenDto | null;
  onFrozen?: (value: PblFrozenDto) => void;
}) {
  const [frozen, setFrozen] = useState(initialFrozen);
  const [authorLoaded, setAuthorLoaded] = useState(Boolean(initialFrozen));
  const [sourceJson, setSourceJson] = useState(() =>
    JSON.stringify(makeTemplate(lesson, learnerUid), null, 2),
  );
  const [definition, setDefinition] = useState<PblProjectDefinitionDto | null>(() =>
    pblProjectDefinitionSchema.parse(makeTemplate(lesson, learnerUid)),
  );
  const [semanticReviewed, setSemanticReviewed] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nonce = useRef<{ key: string; requestId: string } | null>(null);
  const scope = { projectId, generation };
  const headers = useMemo(
    () => projectScopeHeaders({ projectId, generation }),
    [projectId, generation],
  );
  const referencesGrounded = Boolean(
    definition &&
    definition.statementIds.length > 0 &&
    definition.statementIds.every(
      (id) =>
        lesson.statementIds.includes(id) && statements.some((item) => item.statementId === id),
    ),
  );

  useEffect(() => {
    setFrozen(initialFrozen);
    if (initialFrozen) {
      setAuthorLoaded(true);
      setSourceJson(JSON.stringify(initialFrozen.definition, null, 2));
      setDefinition(initialFrozen.definition);
      return;
    }
    setAuthorLoaded(false);
    const controller = new AbortController();
    void apiFetch(
      `/api/study/pbl?lessonId=${encodeURIComponent(lesson.lessonId)}&lessonVersion=${lesson.version}`,
      authorReadSchema,
      { headers, cache: 'no-store', signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result) {
          setFrozen(null);
          setAuthorLoaded(true);
          return;
        }
        const saved = result.frozen;
        setFrozen(saved);
        setAuthorLoaded(true);
        setSourceJson(JSON.stringify(saved.definition, null, 2));
        setDefinition(saved.definition);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(describeApiError(caught));
      });
    return () => controller.abort();
  }, [initialFrozen, lesson.lessonId, lesson.version, headers]);
  const edit = (text: string) => {
    setSourceJson(text);
    setDefinition(null);
    setSemanticReviewed(false);
    setError(null);
    nonce.current = null;
    try {
      const parsed: unknown = JSON.parse(text);
      const result = pblProjectDefinitionSchema.safeParse(parsed);
      if (!result.success) {
        setError(`定义不符合严格合同：${result.error.issues[0]?.message ?? '请检查字段与引用。'}`);
        return;
      }
      setDefinition(result.data);
    } catch {
      setError('请输入合法 JSON；必须显式补齐项目情境、角色、任务、里程碑和评分依据。');
    }
  };
  const submitReview = async () => {
    if (!definition || !semanticReviewed || reviewNote.trim().length < 2 || busy || frozen) return;
    const key = JSON.stringify({
      definition,
      reviewNote: reviewNote.trim(),
      lesson,
      semanticReviewed,
    });
    if (nonce.current?.key !== key) nonce.current = { key, requestId: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      const body = {
        operation: 'review' as const,
        scope,
        binding: {
          version: 1 as const,
          stageId: `stage_formal_${lesson.lessonId}_v${lesson.version}`,
          definitionId: definition.id,
          documentDigest: 'draft-review',
          definitionDigest: 'draft-review',
        },
        lessonId: lesson.lessonId,
        lessonVersion: lesson.version,
        semanticReviewed: true as const,
        reviewNote: reviewNote.trim(),
        definition,
      };
      const result = await apiFetch('/api/study/pbl', pblFrozenSchema, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const valid = pblFrozenSchema.parse(result);
      setFrozen(valid);
      nonce.current = null;
      onFrozen?.(valid);
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="card" data-pbl-author>
      <summary>项目式学习定义与人工审核{frozen ? ' · 已冻结' : ' · 未审核草案'}</summary>
      {frozen ? (
        <Notice tone="verified">
          该定义已冻结：v{frozen.lessonVersion} · 审核备注：{frozen.reviewNote}
          。历史项目定义不会自动补审。
        </Notice>
      ) : (
        <>
          <p>
            编辑的是尚未审核的项目草案。请逐项检查陈述引用、公开目标、任务和确定性检查；评分依据仅作为本地审核输入，不进入课堂静态内容。语义审核勾选初始为否，任何编辑都会清除勾选。
          </p>
          <label className="field">
            <span>项目定义 JSON（严格合同）</span>
            <textarea
              data-pbl-definition
              rows={18}
              value={sourceJson}
              disabled={busy}
              onChange={(event) => edit(event.target.value)}
            />
          </label>
          {definition ? (
            <section aria-label="待审核项目定义">
              <h3>{definition.title}</h3>
              <p>真实对象：{definition.authenticContext.audience}</p>
              <p>真实问题：{definition.authenticContext.problem}</p>
              <p>约束：{definition.authenticContext.constraints.join('；')}</p>
              <h4>锚定陈述与来源</h4>
              <ul>
                {definition.statementIds.map((statementId) => {
                  const statement = statements.find((item) => item.statementId === statementId);
                  return (
                    <li key={statementId}>
                      <strong>{statementId}</strong>
                      {statement ? (
                        <>
                          <p>{statement.text}</p>
                          {statement.conditions ? <p>适用条件：{statement.conditions}</p> : null}
                          <p>
                            来源：
                            {statement.evidence
                              .map(
                                (item) =>
                                  `${item.materialId} v${item.revision} · ${item.segmentId} · ${item.use}`,
                              )
                              .join('；')}
                          </p>
                        </>
                      ) : (
                        <p>该陈述不在当前冻结证据包中，不能冻结此定义。</p>
                      )}
                    </li>
                  );
                })}
              </ul>
              <h4>目标</h4>
              <ul>
                {definition.goals.map((goal) => (
                  <li key={goal.id}>
                    {goal.statement} — {goal.successDescription}
                  </li>
                ))}
              </ul>
              <h4>任务与确定性要求</h4>
              <ul>
                {definition.tasks.map((task) => (
                  <li key={task.id}>
                    {task.title}：{task.outcome}；
                    {task.checks.map((check) => check.expectation).join('；')}
                  </li>
                ))}
              </ul>
              <h4>里程碑</h4>
              <ul>
                {definition.milestones.map((item) => (
                  <li key={item.id}>
                    {item.title}：{item.checks.map((check) => check.expectation).join('；')}
                  </li>
                ))}
              </ul>
              <h4>私有评分依据（仅作者审核）</h4>
              <ul>
                {definition.rubrics.map((rubric) => (
                  <li key={rubric.id}>
                    {rubric.criterion}：
                    {rubric.levels.map((level) => `${level.level}=${level.descriptor}`).join('；')}
                  </li>
                ))}
              </ul>
              <label>
                <input
                  data-pbl-semantic-review
                  type="checkbox"
                  checked={semanticReviewed}
                  disabled={busy || !referencesGrounded}
                  onChange={(event) => setSemanticReviewed(event.target.checked)}
                />{' '}
                我已逐项核对项目情境、陈述、任务检查和评分依据，确认其语义准确
              </label>
              {!referencesGrounded ? (
                <p role="alert">陈述引用未全部命中本版本并显示来源，当前不能进行语义确认或冻结。</p>
              ) : null}
            </section>
          ) : null}
          <label className="field">
            <span>人工审核备注</span>
            <textarea
              data-pbl-review-note
              maxLength={2000}
              value={reviewNote}
              disabled={busy}
              onChange={(event) => setReviewNote(event.target.value)}
            />
          </label>
          <button
            className="btn btn-primary"
            data-pbl-freeze
            type="button"
            disabled={
              !authorLoaded ||
              busy ||
              !definition ||
              !referencesGrounded ||
              !semanticReviewed ||
              reviewNote.trim().length < 2
            }
            onClick={() => void submitReview()}
          >
            {busy ? '正在冻结…' : '人工审核并冻结定义'}
          </button>
          <p className="muted">
            模板已用本版本陈述和当前学习者初始化；AI 角色 UID
            为空。需要由审核人完善内容，不能把模板当作已核验事实。
          </p>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </details>
  );
}
