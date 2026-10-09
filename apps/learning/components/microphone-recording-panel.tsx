'use client';

import { useEffect, useRef, useState } from 'react';
import { MicrophoneRecorder, type RecordingState } from '../lib/microphone-recorder';
import { saveRecording } from '../lib/save-recording';
import { describeApiError } from '../lib/client';
import { Notice } from './ui';

export function MicrophoneRecordingPanel({
  projectId,
  generation,
  disabled,
  onSaved,
}: {
  projectId: string;
  generation: number;
  disabled: boolean;
  onSaved: (asset: { assetId: string; mime: string; seconds: number }) => void;
}) {
  const [state, setState] = useState<RecordingState>({ state: 'idle' });
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const recorder = useRef<MicrophoneRecorder | null>(null);
  const requestId = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    const current = new MicrophoneRecorder((value) => {
      if (active.current) setState(value);
    });
    recorder.current = current;
    return () => {
      active.current = false;
      current.dispose();
      controller.current?.abort();
      recorder.current = null;
    };
  }, [projectId, generation]);
  useEffect(() => {
    if (state.state !== 'ready') return;
    const next = URL.createObjectURL(
      new Blob([new Uint8Array(state.bytes)], { type: 'audio/wav' }),
    );
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [state]);

  const persist = async () => {
    if (state.state !== 'ready' || busy || disabled || saved) return;
    requestId.current ??= crypto.randomUUID();
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    setError(null);
    try {
      const asset = await saveRecording(
        { projectId, generation },
        requestId.current,
        state.bytes,
        pending.signal,
      );
      if (active.current && !pending.signal.aborted) {
        onSaved(asset);
        setSaved(true);
      }
    } catch (caught) {
      if (active.current && !pending.signal.aborted) setError(describeApiError(caught));
    } finally {
      if (active.current && !pending.signal.aborted) setBusy(false);
      if (controller.current === pending) controller.current = null;
    }
  };

  return (
    <section className="card" data-microphone-recording>
      <h3>录制音频</h3>
      <p className="muted">
        点击开始后申请麦克风权限；最长 5
        分钟，达到大小上限会自动停止。保存只写入当前项目，转写需另行授权。
      </p>
      <p role="status">
        {state.state === 'requesting'
          ? '正在申请麦克风权限…'
          : state.state === 'recording'
            ? '正在录音，请停止后试听。'
            : state.state === 'ready'
              ? `录音 ${state.seconds.toFixed(1)} 秒${saved ? '，已保存并选中' : '，尚未保存'}`
              : '尚未录音'}
      </p>
      <div className="row-inline">
        <button
          className="btn"
          type="button"
          disabled={disabled || busy || state.state === 'recording' || state.state === 'requesting'}
          onClick={() => {
            requestId.current = null;
            setSaved(false);
            setError(null);
            void recorder.current?.start();
          }}
        >
          开始录音
        </button>
        <button
          className="btn"
          type="button"
          disabled={state.state !== 'recording'}
          onClick={() => recorder.current?.stop()}
        >
          停止录音
        </button>
        <button
          className="btn"
          type="button"
          disabled={busy || disabled || state.state !== 'ready' || saved}
          onClick={() => void persist()}
        >
          {busy ? '正在保存…' : '保存并选择录音'}
        </button>
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => {
            recorder.current?.discard();
            requestId.current = null;
            setSaved(false);
            setError(null);
          }}
        >
          {state.state === 'requesting' ? '取消申请' : '丢弃本地录音'}
        </button>
      </div>
      {state.state === 'ready' && url ? (
        <audio controls src={url} preload="metadata" aria-label="试听本地录音" />
      ) : null}
      {state.state === 'error' ? <Notice tone="error">{state.message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </section>
  );
}
