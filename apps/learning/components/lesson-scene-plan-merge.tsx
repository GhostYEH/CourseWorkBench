'use client';

/**
 * 跨版本场景计划差异与合并（LESSON-02 / OMA-005、OMA-022）。
 *
 * 合并是**有版本与审核语义**的操作：`merge-scene-plans` 只做只读预览（增/删/改/序、冲突与大纲缺口），
 * 真正写回仍走 `save-scene-plan`——带 `baseRevision` 做乐观并发，内容一变旧审核即失效，
 * 新版本必须重新人工审核后才能发布。界面因此把「会怎么合、哪些要人确认」先摊开给用户看，
 * 再让用户显式确认写入；冲突场景一律保留目标版本当前内容并如实列出，绝不静默取一侧。
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  apiResponses,
  scenePlanMergeSchema,
  scenePlanSaveSchema,
  type ScenePlanMergePreviewDto,
} from '@sew/study-contracts';
import { Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';
import { useCommand } from '../lib/use-command';
import {
  beginLessonCommandAttempt,
  lessonCommandFailureState,
  type LessonCommandAttempt,
} from './lesson-command-retry';

const CONFLICT_LABEL: Record<string, string> = {
  both_modified: '两侧都改了同一场景',
  kind_changed: '场景种类被换掉',
  removed_and_modified: '一侧删除、另一侧修改',
  added_duplicate: '两侧新增了同一编号但内容不同',
};

const ScenePlanMerge = ({
  projectId,
  generation,
  lessonId,
  lessonVersion,
  planRevision,
  sourceVersions,
  busy,
  onSaved,
}: {
  projectId: string;
  generation: number;
  lessonId: string;
  lessonVersion: number;
  /** 目标草案版本当前的计划修订；没有计划时为 0。 */
  planRevision: number;
  /** 可选来源版本（同一课程的其他已冻结/草案版本，且该版本有计划）。 */
  sourceVersions: number[];
  busy: boolean;
  onSaved: (message: string) => void;
}): ReactNode => {
  const router = useRouter();
  const [source, setSource] = useState<string>(sourceVersions[0]?.toString() ?? '');
  const [preview, setPreview] = useState<ScenePlanMergePreviewDto | null>(null);
  const [attempt, setAttempt] = useState<LessonCommandAttempt | null>(null);
  /** 逐项冲突决议：sceneId → choice。全部冲突都有决议才允许写入。 */
  const [resolutions, setResolutions] = useState<Record<string, 'current' | 'incoming'>>({});
  const command = useCommand([projectId, generation, lessonId, lessonVersion].join(':'));
  const { error, setError } = command;
  const disabled = busy || command.busy || attempt !== null;

  const conflictIds = useMemo(
    () => new Set(preview?.conflicts.map((conflict) => conflict.sceneId) ?? []),
    [preview],
  );
  const allConflictsResolved = useMemo(
    () =>
      preview
        ? preview.conflicts.every((conflict) => resolutions[conflict.sceneId] !== undefined)
        : false,
    [preview, resolutions],
  );

  const loadPreview = async (
    withResolutions: boolean,
  ): Promise<ScenePlanMergePreviewDto | null> => {
    const parsed = scenePlanMergeSchema.safeParse({
      scope: { projectId, generation },
      action: 'merge-scene-plans',
      lessonId,
      fromVersion: Number(source),
      toVersion: lessonVersion,
      resolutions:
        withResolutions && preview && allConflictsResolved
          ? preview.conflicts.map((conflict) => ({
              sceneId: conflict.sceneId,
              choice: resolutions[conflict.sceneId]!,
            }))
          : undefined,
    });
    if (!parsed.success) {
      setError('请选择要合并进来的来源版本。');
      return null;
    }
    let merged: ScenePlanMergePreviewDto | null = null;
    await command.run(
      ({ signal }) =>
        apiFetch('/api/study/lessons', apiResponses.lessonScenePlanMerge, {
          method: 'POST',
          signal,
          body: JSON.stringify(parsed.data),
        }),
      {
        onSuccess: (result) => {
          merged = result.merge;
          setPreview(result.merge);
          setError(null);
        },
        onError: (caught) => setError(describeApiError(caught)),
      },
    );
    return merged;
  };

  /** 把预览出来的合并结果写入本草案版本：仍走 save-scene-plan 的乐观并发与幂等回执。 */
  const apply = async (): Promise<void> => {
    if (!preview || attempt?.state === 'failed') return;
    if (!allConflictsResolved) {
      setError('还有未决议的冲突；请为每处冲突选择「保留本版本」或「采用来源版本」后再写入。');
      return;
    }
    // 带冲突决议时先重算一次预览（决议会改变合并结果），再写入重算后的计划。
    const mergedScenes = preview.conflicts.length
      ? (await loadPreview(true))?.mergedScenes
      : preview.mergedScenes;
    if (!mergedScenes) return;
    let submitted = attempt;
    if (!submitted) {
      const parsed = scenePlanSaveSchema.safeParse({
        scope: { projectId, generation },
        action: 'save-scene-plan',
        requestId: crypto.randomUUID(),
        lessonId,
        version: lessonVersion,
        baseRevision: planRevision,
        scenes: mergedScenes,
      });
      if (!parsed.success) {
        setError('合并结果不符合计划合同，未写入。请重新预览后再试。');
        return;
      }
      submitted = beginLessonCommandAttempt(parsed.data, parsed.data.requestId);
    }
    const original = submitted;
    await command.run(
      ({ signal }) =>
        apiFetch('/api/study/lessons', apiResponses.lessonScenePlan, {
          method: 'POST',
          signal,
          body: original.body,
        }),
      {
        onStart: () => setAttempt({ ...original, state: 'pending' }),
        onSuccess: (result) => {
          setAttempt(null);
          setPreview(null);
          onSaved(
            `已合并到 v${lessonVersion} 场景计划：${result.plan.scenes.length} 个场景，修订 ${result.plan.revision}；需重新审核后才能发布。`,
          );
          router.refresh();
        },
        onError: (caught) => {
          setAttempt({ ...original, state: lessonCommandFailureState(caught) });
          setError(describeApiError(caught));
        },
      },
    );
  };

  return (
    <details className="card">
      <summary>跨版本计划差异与合并</summary>
      <p className="muted">
        比较另一版本的场景计划与 v{lessonVersion}：增/删/改/序会先摊开，无法自动判定的冲突
        保留本版本当前状态（包括删除）并如实列出。写入仍走场景计划保存，内容一变旧审核即失效。
      </p>
      {sourceVersions.length === 0 ? (
        <p className="muted">本课程还没有其他带场景计划的版本，暂无可合并内容。</p>
      ) : (
        <>
          <label className="field">
            <span>来源版本（要合并进来的计划）</span>
            <select
              value={source}
              disabled={disabled}
              data-plan-merge-source
              onChange={(event) => {
                setSource(event.target.value);
                setPreview(null);
                setResolutions({});
                setError(null);
              }}
            >
              {sourceVersions.map((version) => (
                <option key={version} value={version}>
                  课程版本 v{version}
                </option>
              ))}
            </select>
          </label>
          <div className="row-inline">
            <button
              type="button"
              className="btn"
              disabled={disabled || !source}
              data-plan-merge-preview
              onClick={() => void loadPreview(false)}
            >
              {command.busy ? '正在比较…' : '预览差异与合并结果'}
            </button>
            {preview ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={disabled || !allConflictsResolved}
                data-plan-merge-apply
                onClick={() => void apply()}
              >
                {command.busy ? '正在写入…' : '确认写入本草案版本'}
              </button>
            ) : null}
          </div>
        </>
      )}
      {attempt?.state === 'unknown' ? (
        <Notice tone="pending">
          本次合写结果尚未确认，原内容与请求编号已保留。核对回执会重放原请求，不会重复推进修订。
          <button
            type="button"
            className="btn"
            disabled={command.busy}
            data-plan-merge-retry
            onClick={() => void apply()}
          >
            核对写入回执
          </button>
        </Notice>
      ) : null}
      {attempt?.state === 'failed' ? (
        <Notice tone="pending">
          回执确认本次写入失败或取消，计划未变更。
          <button
            type="button"
            className="btn"
            data-plan-merge-new-attempt
            onClick={() => {
              setAttempt(null);
              setError(null);
            }}
          >
            开启新的合并尝试
          </button>
        </Notice>
      ) : null}
      {preview ? (
        <div data-plan-merge-preview-result>
          <p className="secondary">
            来源 v{preview.fromVersion} → 目标 v{preview.toVersion}（共同祖先 v{preview.baseVersion}
            ）： 新增 {preview.diff.added.length}、删除 {preview.diff.removed.length}、修改{' '}
            {preview.diff.modified.length}
            {preview.diff.reordered ? '；顺序有变化' : ''}。合并后 {preview.mergedScenes.length}{' '}
            个场景。
          </p>
          {preview.diff.added.length > 0 ? (
            <p className="muted" data-plan-merge-added>
              新增：{preview.diff.added.map((item) => item.title).join('、')}
            </p>
          ) : null}
          {preview.diff.removed.length > 0 ? (
            <p className="muted" data-plan-merge-removed>
              删除：{preview.diff.removed.map((item) => item.title).join('、')}
            </p>
          ) : null}
          {preview.diff.modified.length > 0 ? (
            <p className="muted" data-plan-merge-modified>
              修改：{preview.diff.modified.map((item) => item.title).join('、')}
            </p>
          ) : null}
          {preview.outlineMissingStatementIds.length > 0 ? (
            <Notice tone="pending">
              按整课大纲对齐后仍有 {preview.outlineMissingStatementIds.length}{' '}
              条已选陈述没有对应场景（{preview.outlineMissingStatementIds.join('、')}）；
              合并不会自动补场景，请手动新增或用模型候选补齐。
            </Notice>
          ) : null}
          {preview.conflicts.length > 0 ? (
            <Notice tone="pending" data-plan-merge-conflicts>
              有 {preview.conflicts.length} 处无法自动判定。逐项决议后才能写入：
              <ul className="check-list">
                {preview.conflicts.map((conflict) => (
                  <li key={conflict.sceneId}>
                    <span className="mono">{conflict.sceneId.slice(0, 18)}…</span>
                    <span>
                      {CONFLICT_LABEL[conflict.reason] ?? conflict.reason}
                      {conflictIds.has(conflict.sceneId) ? '（本版本状态保留）' : ''}
                    </span>
                    <span className="row-inline">
                      <label>
                        <input
                          type="radio"
                          name={`merge-resolution-${conflict.sceneId}`}
                          checked={resolutions[conflict.sceneId] === 'current'}
                          disabled={disabled}
                          data-plan-merge-keep={conflict.sceneId}
                          onChange={() =>
                            setResolutions((current) => ({
                              ...current,
                              [conflict.sceneId]: 'current',
                            }))
                          }
                        />
                        保留本版本
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`merge-resolution-${conflict.sceneId}`}
                          checked={resolutions[conflict.sceneId] === 'incoming'}
                          disabled={disabled}
                          data-plan-merge-use={conflict.sceneId}
                          onChange={() =>
                            setResolutions((current) => ({
                              ...current,
                              [conflict.sceneId]: 'incoming',
                            }))
                          }
                        />
                        采用来源版本
                      </label>
                    </span>
                  </li>
                ))}
              </ul>
              {!allConflictsResolved ? (
                <p className="muted">仍有未决议的冲突：请为每处冲突选择一侧后再写入。</p>
              ) : null}
            </Notice>
          ) : (
            <p className="muted">没有无法自动判定的冲突。</p>
          )}
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </details>
  );
};

/** Scope changes remount local snapshots; the command gate also isolates late network responses. */
export const LessonScenePlanMerge = (props: Parameters<typeof ScenePlanMerge>[0]): ReactNode => (
  <ScenePlanMerge
    key={[
      props.projectId,
      props.generation,
      props.lessonId,
      props.lessonVersion,
      props.planRevision,
    ].join(':')}
    {...props}
  />
);
