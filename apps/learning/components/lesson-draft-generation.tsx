'use client';

import { apiResponses } from '@sew/study-contracts';

/**
 * 课程草案生成（LESSON-02 / M2-A）。
 *
 * 只提交证据包编号与补充说明：陈述与来源由服务端读取，guard 判不过就一次调用都不发出。
 * 返回的正文按「草案」展示，不写入知识清单或课程版本，因此不会因为没有人工审核就进入教学。
 */

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { EvidenceBundleViewDto, LessonVersionDto, ModelGenerationInput } from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

type LessonGenerationPurpose = ModelGenerationInput['purpose'];
const PURPOSE_LABEL: Record<LessonGenerationPurpose, string> = {
  lesson_draft: '课程草案（本节要讲什么）',
  teaching_prompt: '课堂讲解/提示（须已发布并审核）',
};

export const LessonDraftGeneration = ({
  projectId,
  generation,
  bundles,
  publishedLessons,
  configured,
}: {
  projectId: string;
  generation: number;
  bundles: EvidenceBundleViewDto[];
  publishedLessons: LessonVersionDto[];
  configured: boolean;
}): ReactNode => {
  const router = useRouter();
  const [bundleId, setBundleId] = useState(bundles[0]?.bundleId ?? '');
  const [purpose, setPurpose] = useState<LessonGenerationPurpose>('lesson_draft');
  const [lessonId, setLessonId] = useState(publishedLessons[0]?.lessonId ?? '');
  const [instruction, setInstruction] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [usage, setUsage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inflight = useRef<AbortController | null>(null);
  const pendingRequest = useRef<{ key: string; id: string } | null>(null);

  /** 停止：断开本次 HTTP 请求，服务端据此中止正在执行的 provider 调用。 */
  const stop = (): void => {
    inflight.current?.abort('教师已停止本次生成');
    setError('已请求停止本次生成；已发出的调用仍计入预算，迟到的正文不会进入草案。');
  };

  const activeBundle = bundles.find((bundle) => bundle.bundleId === bundleId) ?? null;
  const teaching = purpose === 'teaching_prompt';

  const run = async (): Promise<void> => {
    if (inflight.current) return;
    if (teaching && !lessonId) {
      setError('课堂讲解/提示必须选择一节已发布的课程；没有已发布课程时请先完成审核与发布。');
      return;
    }
    if (!teaching && !activeBundle) {
      setError('请先选择一个已冻结的证据包。');
      return;
    }
    setBusy(true);
    setError(null);
    setDraft(null);
    const controller = new AbortController();
    inflight.current = controller;
    try {
      const nonceKey = `sew-generation:${projectId}:${purpose}:${bundleId}:${lessonId}:${encodeURIComponent(instruction.trim())}`;
      let persistedId: string | null = null;
      try { persistedId = localStorage.getItem(nonceKey); } catch { /* Keep page-local retry identity. */ }
      const requestId = persistedId ?? (pendingRequest.current?.key === nonceKey ? pendingRequest.current.id : crypto.randomUUID());
      pendingRequest.current = { key: nonceKey, id: requestId };
      try { localStorage.setItem(nonceKey, requestId); } catch { /* Cross-page persistence is unavailable. */ }
      const result = await apiFetch('/api/study/generate', apiResponses.modelGenerate, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          scope: { projectId, generation },
          requestId,
          purpose,
          // 课堂讲解按已发布版本自带的证据包取来源，避免课程与证据包被拆开提交。
          bundleId: teaching ? (publishedLessons.find((lesson) => lesson.lessonId === lessonId)?.bundleId ?? '') : activeBundle!.bundleId,
          lessonId: teaching ? lessonId : null,
          instruction,
        }),
      });
      if (result.callState !== 'started') {
        pendingRequest.current = null;
        try { localStorage.removeItem(nonceKey); } catch { /* Page-local receipt already cleared. */ }
      }
      setUsage(
        `本 run 已用 ${result.usage.callsUsed}/${result.usage.maxCalls} 次调用、`
        + `${result.usage.tokensUsed}/${result.usage.maxTokens} token（含未确认预留）；剩余 ${result.remainingCalls} 次。`
        + ` 服务商本次用量：${result.providerTokens === null || result.providerTokens === undefined ? '未知' : result.providerTokens}；费用未知。`,
      );
      if (!result.ok) {
        setError(`${result.message}（${result.elapsedMs} ms）`);
      } else {
        setDraft(result.text ?? '模型未返回可显示的正文。');
      }
      // run 事件与状态已经落库，刷新让运行面板读到最新台账。
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      inflight.current = null;
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>课程草案生成</h2>
      <p className="secondary">
        生成前先核对：是否已有已确认计划启动的 run、本 run 额度是否用满、冻结之后来源是否变化、
        陈述是否仍通过准入。任一项不成立都会给出具体阻断原因，不会向模型服务发出请求。
      </p>
      {bundles.length === 0 ? (
        <Empty>还没有可引用的证据包，请先冻结证据包。</Empty>
      ) : (
        <>
          <div className="field">
            <label htmlFor="generate-purpose">调用用途</label>
            <select
              id="generate-purpose"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value as LessonGenerationPurpose)}
              disabled={busy}
            >
              {(Object.keys(PURPOSE_LABEL) as LessonGenerationPurpose[]).map((value) => (
                <option key={value} value={value}>{PURPOSE_LABEL[value]}</option>
              ))}
            </select>
            <span className="hint">
              {teaching
                ? '课堂用途额外要求课程已发布且本版本审核通过；引用来源仍按证据包核对，失效即阻断。'
                : '草案用途只产出待审核文本，不写入知识点或课程版本。'}
            </span>
          </div>
          {teaching ? (
            <div className="field">
              <label htmlFor="generate-lesson">已发布课程</label>
              {publishedLessons.length === 0 ? (
                <Empty>还没有已发布的课程版本。</Empty>
              ) : (
                <select id="generate-lesson" value={lessonId} onChange={(event) => setLessonId(event.target.value)} disabled={busy}>
                  {publishedLessons.map((lesson) => (
                    <option key={lesson.lessonId} value={lesson.lessonId}>
                      {lesson.title} · v{lesson.version}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : (
            <div className="field">
              <label htmlFor="generate-bundle">引用证据包</label>
              <select
                id="generate-bundle"
                value={bundleId}
                onChange={(event) => setBundleId(event.target.value)}
                disabled={busy}
              >
                {bundles.map((bundle) => (
                  <option key={bundle.bundleId} value={bundle.bundleId}>
                    {bundle.digest.slice(0, 12)}… · 计划 v{bundle.bundle.planVersion} ·
                    {' '}{bundle.bundle.statements.length} 条陈述
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="generate-instruction">补充说明（按数据对待，不作为事实来源）</label>
            <textarea
              id="generate-instruction"
              rows={3}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder="例如：面向基础薄弱的学生，先给图像直觉再给定义"
              disabled={busy}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void run()}
            disabled={busy || !configured || (!teaching && activeBundle === null)}
          >
            {teaching ? '生成课堂讲解提示' : '生成课程草案'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={stop}
            disabled={!busy}
            title="断开本次请求；服务端会中止正在执行的模型调用"
          >
            停止本次生成
          </button>
          {!configured ? (
            <Notice tone="pending" style={{ marginTop: 'var(--sew-space-3)' }}>
              尚未配置模型连接。请到「设置 · 模型连接」完成配置并做真实连接测试；配置密钥不会进入本页面。
            </Notice>
          ) : null}
          {usage ? (
            <Notice tone="info" style={{ marginTop: 'var(--sew-space-3)' }}>{usage}</Notice>
          ) : null}
          {draft ? (
            <Notice tone="pending" style={{ marginTop: 'var(--sew-space-3)' }}>
              <strong>模型草案，未进入权威记录。</strong>
              <p className="secondary" style={{ whiteSpace: 'pre-wrap' }}>{draft}</p>
              <p className="hint">需要人工把它整理成候选知识点陈述并通过审核后，才能进入证据包与课程版本。</p>
            </Notice>
          ) : null}
        </>
      )}
      {error ? (
        <Notice tone="error" style={{ marginTop: 'var(--sew-space-3)' }}>{error}</Notice>
      ) : null}
    </div>
  );
};
