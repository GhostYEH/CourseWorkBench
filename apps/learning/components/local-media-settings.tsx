'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  apiResponses,
  localMediaConfigurationInputSchema,
  type LocalMediaConfigurationStatus,
} from '@sew/study-contracts';
import { apiFetch } from '../lib/client';
import { Notice } from './ui';

export const LocalMediaSettings = ({
  onStatus,
}: {
  onStatus?: (status: LocalMediaConfigurationStatus) => void;
}): ReactNode => {
  const [status, setStatus] = useState<LocalMediaConfigurationStatus | null>(null);
  const [comfyEnabled, setComfyEnabled] = useState(false);
  const [comfyUrl, setComfyUrl] = useState('http://127.0.0.1:8188');
  const [checkpoint, setCheckpoint] = useState('');
  const [comfyToken, setComfyToken] = useState('');
  const [whisperEnabled, setWhisperEnabled] = useState(false);
  const [whisperUrl, setWhisperUrl] = useState('http://127.0.0.1:9000/v1');
  const [whisperModel, setWhisperModel] = useState('');
  const [whisperToken, setWhisperToken] = useState('');
  const [funAsrEnabled, setFunAsrEnabled] = useState(false);
  const [funAsrUrl, setFunAsrUrl] = useState('http://127.0.0.1:10095');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const read = useCallback(async (): Promise<LocalMediaConfigurationStatus> => {
    const data = await apiFetch('/api/study/models/local', apiResponses.localMediaConfiguration, {
      cache: 'no-store',
    });
    setStatus(data);
    onStatus?.(data);
    if (data.comfyUi.configured) {
      setComfyEnabled(true);
      setCheckpoint(data.comfyUi.checkpoint ?? '');
      setComfyUrl('');
    }
    if (data.whisper.configured) {
      setWhisperEnabled(true);
      setWhisperModel(data.whisper.model ?? '');
      setWhisperUrl('');
    }
    if (data.funAsr.configured) {
      setFunAsrEnabled(true);
      setFunAsrUrl('');
    }
    return data;
  }, [onStatus]);
  useEffect(() => {
    void read().catch(() => setError('无法读取本地媒体配置。'));
  }, [read]);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const raw = {
        ...(comfyEnabled
          ? {
              comfyUi: {
                baseUrl: comfyUrl,
                checkpoint,
                ...(comfyToken ? { bearerToken: comfyToken } : {}),
              },
            }
          : {}),
        ...(whisperEnabled
          ? {
              whisper: {
                baseUrl: whisperUrl,
                model: whisperModel,
                ...(whisperToken ? { bearerToken: whisperToken } : {}),
              },
            }
          : {}),
        ...(funAsrEnabled ? { funAsr: { baseUrl: funAsrUrl } } : {}),
      };
      const parsed = localMediaConfigurationInputSchema.safeParse(raw);
      if (!parsed.success) throw new Error('请检查地址、checkpoint 文件名和远程服务凭据。');
      const data = await apiFetch('/api/study/models/local', apiResponses.localMediaConfiguration, {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      });
      setStatus(data);
      onStatus?.(data);
      setComfyToken('');
      setWhisperToken('');
      setMessage(
        '本地媒体配置已保存在当前服务进程内存中；重启后需重新配置。页面只显示脱敏状态，不回显凭据。',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '本地媒体配置失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" data-local-media-settings>
      <h2>本地媒体引擎</h2>
      <p className="muted">
        配置仅保存在当前服务进程内存，不写项目数据库或备份。loopback 可用 HTTP；其他地址需要 HTTPS
        和 bearer 凭据。工作流固定为安全文生图图，不能从页面上传
        JSON。出于隐私原因不回显完整服务地址和凭据；已配置地址的输入框留空，保存前必须重新输入完整地址。
      </p>
      <p data-local-media-status>
        {status
          ? `状态：${status.configured ? '至少一个引擎已配置' : '未配置'} · ${status.storage === 'memory_only' ? '仅本次服务运行' : ''}`
          : '读取配置中…'}
      </p>
      <fieldset disabled={busy}>
        <legend>ComfyUI 图片生成</legend>
        <label>
          <input
            type="checkbox"
            checked={comfyEnabled}
            onChange={(event) => setComfyEnabled(event.target.checked)}
          />
          启用固定安全工作流
        </label>
        {comfyEnabled ? (
          <>
            <label className="field">
              服务地址
              <input
                type="url"
                value={comfyUrl}
                onChange={(event) => setComfyUrl(event.target.value)}
              />
            </label>
            <label className="field">
              已安装 checkpoint 文件名
              <input
                value={checkpoint}
                onChange={(event) => setCheckpoint(event.target.value)}
                placeholder="例如 model.safetensors；不会自动下载"
              />
            </label>
            <label className="field">
              远程 bearer 凭据（本机服务可留空）
              <input
                type="password"
                autoComplete="off"
                value={comfyToken}
                onChange={(event) => setComfyToken(event.target.value)}
              />
            </label>
          </>
        ) : null}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Whisper OpenAI 兼容转写</legend>
        <label>
          <input
            type="checkbox"
            checked={whisperEnabled}
            onChange={(event) => setWhisperEnabled(event.target.checked)}
          />
          启用
        </label>
        {whisperEnabled ? (
          <>
            <label className="field">
              服务地址（包含 /v1）
              <input
                type="url"
                value={whisperUrl}
                onChange={(event) => setWhisperUrl(event.target.value)}
              />
            </label>
            <label className="field">
              服务模型标识
              <input
                value={whisperModel}
                onChange={(event) => setWhisperModel(event.target.value)}
                placeholder="例如 whisper-1 或 whisper-large-v3"
              />
            </label>
            <label className="field">
              远程 bearer 凭据（本机服务可留空）
              <input
                type="password"
                autoComplete="off"
                value={whisperToken}
                onChange={(event) => setWhisperToken(event.target.value)}
              />
            </label>
          </>
        ) : null}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>FunASR 官方 runtime</legend>
        <label>
          <input
            type="checkbox"
            checked={funAsrEnabled}
            onChange={(event) => setFunAsrEnabled(event.target.checked)}
          />
          启用本机 WebSocket runtime
        </label>
        {funAsrEnabled ? (
          <label className="field">
            loopback 服务地址
            <input
              type="url"
              value={funAsrUrl}
              onChange={(event) => setFunAsrUrl(event.target.value)}
            />
          </label>
        ) : null}
      </fieldset>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
        {busy ? '保存中…' : '保存本地引擎配置'}
      </button>
      {message ? (
        <Notice tone="verified" role="status">
          {message}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      ) : null}
    </section>
  );
};
