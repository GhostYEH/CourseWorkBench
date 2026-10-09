'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  apiResponses,
  mediaGenerationCommandSchema,
  type MediaGenerationCommandDto,
  type MediaTaskDto,
  type MediaTasksViewDto,
  type MediaTaskKind,
  type LocalMediaConfigurationStatus,
} from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';
import { Notice } from './ui';
import { MediaProductPreview } from './media-product-preview';
import { MicrophoneRecordingPanel } from './microphone-recording-panel';
import { LocalMediaSettings } from './local-media-settings';

export interface MediaLessonOption {
  lessonId: string;
  title: string;
  statements: string[];
}
export interface MediaAudioOption {
  assetId: string;
  mime: string;
  seconds?: number;
}
const labels: Record<MediaTaskKind, string> = {
  image: '图片',
  video: '视频（兼容服务）',
  tts: '讲解音频',
  asr: '录音转写',
};
const quantity = (value: MediaTasksViewDto['limits']): string =>
  `${value.images} 张 / ${value.seconds} 秒 / ${value.characters} 字符 / ${value.tokens} token`;

/** Saved requests retain their original identity until the user explicitly starts a different one. */
export function MediaGenerationPanel({
  projectId,
  generation,
  lessons,
  audioAssets,
  initial,
}: {
  projectId: string;
  generation: number;
  lessons: MediaLessonOption[];
  audioAssets: MediaAudioOption[];
  initial: MediaTasksViewDto;
}): ReactNode {
  const [view, setView] = useState(initial);
  const [lessonId, setLessonId] = useState(lessons[0]?.lessonId ?? '');
  const [kind, setKind] = useState<MediaTaskKind>('image');
  const [workflowLocation, setWorkflowLocation] = useState<'remote' | 'local'>('remote');
  const [asrEngine, setAsrEngine] = useState<'remote' | 'local_funasr' | 'local_whisper'>('remote');
  const [localMediaStatus, setLocalMediaStatus] = useState<LocalMediaConfigurationStatus | null>(
    null,
  );
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [statementIndex, setStatementIndex] = useState(0);
  const [voiceId, setVoiceId] = useState('alloy');
  const [audioId, setAudioId] = useState(audioAssets[0]?.assetId ?? '');
  const [audioSeconds, setAudioSeconds] = useState(audioAssets[0]?.seconds ?? 30);
  const [availableAudio, setAvailableAudio] = useState(audioAssets);
  const [authorized, setAuthorized] = useState(false);
  const [reviewChecked, setReviewChecked] = useState<string | null>(null);
  const [savedCommand, setSavedCommand] = useState<MediaGenerationCommandDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const currentRequest = useRef<AbortController | null>(null);
  const active = useRef(true);
  const query = new URLSearchParams({ projectId, generation: String(generation) }).toString();
  const scope = { projectId, generation };
  const selectedLesson = lessons.find((lesson) => lesson.lessonId === lessonId);
  const localEngineSelected =
    (kind === 'image' && workflowLocation === 'local') ||
    (kind === 'asr' && asrEngine !== 'remote');
  const localEngineReady =
    kind === 'image'
      ? Boolean(localMediaStatus?.comfyUi.configured)
      : asrEngine === 'local_funasr'
        ? Boolean(localMediaStatus?.funAsr.configured)
        : Boolean(localMediaStatus?.whisper.configured);

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      active.current = false;
      controller.abort();
      currentRequest.current?.abort();
    };
  }, [projectId, generation]);

  useEffect(() => {
    if (!view.tasks.some((task) => task.observation.state === 'started')) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const poll = async (): Promise<void> => {
      attempts += 1;
      try {
        const data = await apiFetch(`/api/study/media?${query}`, apiResponses.mediaTasks, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setView(data);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(describeApiError(caught));
          if (attempts < 30)
            timer = setTimeout(() => {
              void poll();
            }, 4000);
        }
      }
    };
    timer = setTimeout(() => {
      void poll();
    }, 4000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, view]);

  const refresh = async (signal?: AbortSignal): Promise<void> => {
    const data = await apiFetch(`/api/study/media?${query}`, apiResponses.mediaTasks, { signal });
    if (active.current && !signal?.aborted) setView(data);
  };

  const generate = async (): Promise<void> => {
    if (busy || !view.runId) return;
    const base = {
      scope: { ...scope, runId: view.runId },
      requestId: crypto.randomUUID(),
      provider:
        kind === 'image' && workflowLocation === 'local'
          ? 'comfyui'
          : kind === 'asr' && asrEngine !== 'remote'
            ? asrEngine === 'local_funasr'
              ? 'funasr'
              : 'whisper'
            : 'openai-compatible',
      ...((kind === 'image' && workflowLocation === 'local') ||
      (kind === 'asr' && asrEngine !== 'remote')
        ? {}
        : { model: model.trim() || undefined }),
      lessonId,
    };
    const value =
      kind === 'image'
        ? {
            ...base,
            kind,
            prompt,
            workflowId: workflowLocation === 'local' ? 'basic-txt2img' : 'images-generations',
            workflowLocation,
            width: 1024,
            height: 1024,
            steps: 20,
            guidance: 7,
            count: 1,
          }
        : kind === 'video'
          ? {
              ...base,
              kind,
              prompt,
              durationSeconds: 4,
              poll: { intervalMs: 2000, maxPolls: 120, deadlineMs: 240000 },
            }
          : kind === 'tts'
            ? {
                ...base,
                kind,
                text: selectedLesson?.statements[statementIndex] ?? '',
                voiceId,
                playbackRate: 1,
              }
            : {
                ...base,
                kind,
                engine: asrEngine,
                microphoneGranted: authorized,
                audioAssetId: audioId,
                audioSeconds,
              };
    const checked = mediaGenerationCommandSchema.safeParse(savedCommand ?? value);
    if (!checked.success) {
      setError('请检查课程、媒体模型及生成内容；转写需要已授权的录音资产。');
      return;
    }
    const command = checked.data;
    setSavedCommand(command);
    setBusy(true);
    setError(null);
    setMessage(null);
    const controller = new AbortController();
    currentRequest.current = controller;
    try {
      const data = await apiFetch('/api/study/media', apiResponses.mediaTask, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify(command),
      });
      if (!active.current || controller.signal.aborted) return;
      setMessage(
        data.task.observation.state === 'completed'
          ? '真实产物已保存，等待人工审核。'
          : data.task.observation.state === 'started'
            ? '原任务尚未结算，继续读回；不会再次派发。'
            : '任务未成功，已保留失败与用量记录。',
      );
      await refresh(controller.signal);
    } catch (caught) {
      if (active.current) {
        setError(
          controller.signal.aborted
            ? '已停止等待，请读回原任务记录。结果未知时不会再次派发。'
            : describeApiError(caught),
        );
        await refresh(lifetime.current?.signal).catch(() => undefined);
      }
    } finally {
      if (active.current) setBusy(false);
      if (currentRequest.current === controller) currentRequest.current = null;
    }
  };

  const review = async (task: MediaTaskDto, decision: 'approved' | 'rejected'): Promise<void> => {
    if (busy || (decision === 'approved' && reviewChecked !== task.taskId)) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/study/media/review', apiResponses.mediaTask, {
        method: 'POST',
        signal: lifetime.current?.signal,
        body: JSON.stringify({
          scope,
          taskId: task.taskId,
          intent: task.intent,
          decision,
          semanticReviewed: decision === 'approved',
          note: '',
        }),
      });
      await refresh(lifetime.current?.signal);
      if (active.current) {
        setReviewChecked(null);
        setMessage(
          decision === 'approved'
            ? '已审核该产物。用于课程时仍需重新审核并发布课程版本。'
            : '已拒绝该产物。',
        );
      }
    } catch (caught) {
      if (active.current) setError(describeApiError(caught));
    } finally {
      if (active.current) setBusy(false);
    }
  };

  const cancel = async (task: MediaTaskDto): Promise<void> => {
    setError(null);
    try {
      await apiFetch('/api/study/media/cancel', apiResponses.mediaTask, {
        method: 'POST',
        signal: lifetime.current?.signal,
        body: JSON.stringify({ scope, taskId: task.taskId }),
      });
      await refresh(lifetime.current?.signal);
    } catch (caught) {
      if (active.current) setError(describeApiError(caught));
    }
  };

  return (
    <div className="card" data-media-generation-panel>
      <LocalMediaSettings onStatus={setLocalMediaStatus} />
      <h2>生成媒体候选</h2>
      <p className="muted">本地或兼容服务只返回待审核候选；生成结果须经人工核对后才能用于教学。</p>
      <label className="field">
        课程
        <select
          value={lessonId}
          disabled={busy || savedCommand !== null}
          onChange={(event) => {
            setLessonId(event.target.value);
            setStatementIndex(0);
          }}
        >
          {lessons.map((lesson) => (
            <option key={lesson.lessonId} value={lesson.lessonId}>
              {lesson.title}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        媒体类型
        <select
          value={kind}
          disabled={busy || savedCommand !== null}
          onChange={(event) => {
            setKind(event.target.value as MediaTaskKind);
            setModel('');
          }}
        >
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {!localEngineSelected ? (
        <label className="field">
          媒体模型
          <input
            value={model}
            disabled={busy || savedCommand !== null}
            onChange={(event) => setModel(event.target.value)}
            placeholder="填写服务实际支持的媒体模型"
          />
        </label>
      ) : null}
      {kind === 'image' ? (
        <label className="field">
          图像引擎
          <select
            value={workflowLocation}
            disabled={busy || savedCommand !== null}
            onChange={(event) => setWorkflowLocation(event.target.value as 'remote' | 'local')}
          >
            <option value="remote">HTTPS 兼容服务</option>
            <option value="local">本地 ComfyUI 固定工作流</option>
          </select>
        </label>
      ) : null}
      {kind === 'asr' ? (
        <label className="field">
          转写引擎
          <select
            value={asrEngine}
            disabled={busy || savedCommand !== null}
            onChange={(event) => setAsrEngine(event.target.value as typeof asrEngine)}
          >
            <option value="remote">HTTPS 兼容服务</option>
            <option value="local_funasr">本地 FunASR runtime</option>
            <option value="local_whisper">本地 Whisper 兼容服务</option>
          </select>
        </label>
      ) : null}
      {kind === 'image' && workflowLocation === 'local' ? (
        <p className="muted">
          {localMediaStatus?.comfyUi.configured
            ? `配置指定 checkpoint：${localMediaStatus.comfyUi.checkpoint ?? '未知'}（未探测文件是否存在）`
            : '尚未配置 ComfyUI 和 checkpoint。不会自动下载模型。'}
        </p>
      ) : null}
      {kind === 'asr' && asrEngine === 'local_funasr' ? (
        <p className="muted">
          FunASR runtime 要求录音为 16 kHz 单声道 PCM16
          WAV；其他采样率会在派发前拒绝，不自动重采样。
        </p>
      ) : null}
      {kind === 'asr' && asrEngine === 'local_whisper' ? (
        <p className="muted">本地 Whisper 需提供 OpenAI 兼容的 /audio/transcriptions 接口。</p>
      ) : null}
      {kind === 'image' || kind === 'video' ? (
        <label className="field">
          制作说明
          <textarea
            value={prompt}
            disabled={busy || savedCommand !== null}
            maxLength={4000}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="说明呈现方式；教学依据由服务从已审核课程读取"
          />
        </label>
      ) : null}
      {kind === 'video' ? (
        <p className="muted">
          视频需要仍提供 Videos 兼容接口的服务；官方 OpenAI 视频服务已停用，配置该地址时不会派发。
        </p>
      ) : null}
      {kind === 'tts' ? (
        <>
          <label className="field">
            已审核讲解
            <select
              value={statementIndex}
              disabled={busy || savedCommand !== null}
              onChange={(event) => setStatementIndex(Number(event.target.value))}
            >
              {selectedLesson?.statements.map((text, index) => (
                <option key={index} value={index}>
                  {text.slice(0, 100)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            预置音色
            <input
              value={voiceId}
              disabled={busy || savedCommand !== null}
              onChange={(event) => setVoiceId(event.target.value)}
            />
          </label>
          <p className="muted">生成音频由 AI 合成。</p>
        </>
      ) : null}
      {kind === 'asr' ? (
        <>
          <MicrophoneRecordingPanel
            key={`${projectId}:${generation}`}
            projectId={projectId}
            generation={generation}
            disabled={busy || savedCommand !== null}
            onSaved={(asset) => {
              setAvailableAudio((previous) => [
                ...previous.filter((item) => item.assetId !== asset.assetId),
                asset,
              ]);
              setAudioId(asset.assetId);
              setAudioSeconds(asset.seconds);
              setAuthorized(false);
            }}
          />
          <label className="field">
            录音资产
            <select
              value={audioId}
              disabled={busy || savedCommand !== null}
              onChange={(event) => {
                setAudioId(event.target.value);
                setAudioSeconds(
                  availableAudio.find((item) => item.assetId === event.target.value)?.seconds ?? 30,
                );
                setAuthorized(false);
              }}
            >
              {availableAudio.map((asset) => (
                <option key={asset.assetId} value={asset.assetId}>
                  {asset.assetId} · {asset.mime}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            录音秒数
            <input
              type="number"
              step="any"
              min={0.1}
              max={600}
              value={audioSeconds}
              disabled={busy || savedCommand !== null}
              onChange={(event) => setAudioSeconds(Number(event.target.value))}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={authorized}
              disabled={busy || savedCommand !== null}
              onChange={(event) => setAuthorized(event.target.checked)}
            />
            我授权将此录音发送到所选服务进行转写
          </label>
        </>
      ) : null}
      <div className="row-inline">
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            busy ||
            !view.runId ||
            !lessonId ||
            (!localEngineSelected && !model.trim() && !savedCommand) ||
            (localEngineSelected && !localEngineReady && !savedCommand)
          }
          onClick={() => void generate()}
        >
          {busy ? '正在请求…' : savedCommand ? '读回原请求' : '生成并保存候选'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setSavedCommand(null);
            setMessage(null);
          }}
        >
          准备新请求
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            currentRequest.current?.abort();
            void refresh(lifetime.current?.signal).catch((caught) => {
              if (active.current) setError(describeApiError(caught));
            });
          }}
        >
          读回记录 / 停止等待
        </button>
      </div>
      {!view.runId ? <Notice tone="pending">请先确认计划并启动学习运行。</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {message ? <Notice tone="verified">{message}</Notice> : null}
      <h3>用量</h3>
      <p className="muted">
        每次运行的媒体上限：{quantity(view.limits)}；与课堂和其他生成共享模型调用次数与 token 额度。
      </p>
      {view.ledger ? (
        <>
          <p>
            实际：{quantity(view.ledger.total.actual)}；估算：
            {quantity(view.ledger.total.estimated)}
          </p>
          <p>
            未知：{quantity(view.ledger.total.unknown)}；未结算预占：
            {quantity(view.ledger.total.unsettled)}
          </p>
          <p>费用未知的调用：{view.ledger.total.unknownCostCalls}；未有价格依据时不记为零元。</p>
        </>
      ) : null}
      <h3>任务与产物</h3>
      {view.tasks.length === 0 ? (
        <p className="muted">尚无媒体任务。</p>
      ) : (
        view.tasks.map((task) => (
          <article className="card" key={task.taskId} data-media-task={task.taskId}>
            <p>
              {labels[task.command.kind]} ·{' '}
              {task.observation.state === 'completed'
                ? '已保存'
                : task.observation.state === 'started'
                  ? '未结算'
                  : '未成功'}{' '}
              ·{' '}
              {task.review.status === 'approved'
                ? '已审核'
                : task.review.status === 'rejected'
                  ? '已拒绝'
                  : '待审核'}
            </p>
            <p className="muted">
              {task.taskId}
              {task.observation.failureKind ? ` · ${task.observation.failureKind}` : ''} · 用量
              {task.observation.usageMeasurement === 'actual'
                ? '实际'
                : task.observation.usageMeasurement === 'estimated'
                  ? '估算'
                  : '未知'}
            </p>
            {task.products.map((product) => (
              <div key={product.assetId}>
                <MediaProductPreview
                  key={`${query}:${product.assetId}`}
                  product={product}
                  query={query}
                />
                <p className="mono">
                  资源编号：{product.assetId}
                  <br />
                  SHA-256：{product.sha256}
                </p>
                {task.review.status === 'approved' && product.kind === 'image' ? (
                  <p>
                    在本课程的新草案中打开场景编辑，将此编号填入“已审核图片编号”；保存后重新审核、发布并生成课件。
                  </p>
                ) : null}
              </div>
            ))}
            {task.observation.state === 'started' ? (
              <button type="button" className="btn" onClick={() => void cancel(task)}>
                取消该任务并保留记录
              </button>
            ) : null}
            {task.observation.state === 'completed' && task.review.status === 'pending_review' ? (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={reviewChecked === task.taskId}
                    onChange={(event) =>
                      setReviewChecked(event.target.checked ? task.taskId : null)
                    }
                  />
                  我已查看真实产物，并核对其内容与课程来源、适用条件一致
                </label>
                <div className="row-inline">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || reviewChecked !== task.taskId}
                    onClick={() => void review(task, 'approved')}
                  >
                    批准产物
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void review(task, 'rejected')}
                  >
                    拒绝产物
                  </button>
                </div>
              </>
            ) : null}
          </article>
        ))
      )}
    </div>
  );
}
