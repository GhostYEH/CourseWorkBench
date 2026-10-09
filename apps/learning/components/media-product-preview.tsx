'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MediaProductRefDto } from '@sew/study-contracts';
import { fetchVerifiedArtifact } from '../lib/verified-artifact';
import { describeApiError } from '../lib/client';
import { Notice } from './ui';

export function MediaProductPreview({
  product,
  query,
}: {
  product: MediaProductRefDto;
  query: string;
}): ReactNode {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const ownedUrl = useRef<string | null>(null);
  const player = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      if (ownedUrl.current) URL.revokeObjectURL(ownedUrl.current);
    };
  }, [query, product.assetId]);
  const open = async (): Promise<void> => {
    if (busy || url) return;
    const signal = lifetime.current?.signal;
    setBusy(true);
    setError(null);
    try {
      const blob = await fetchVerifiedArtifact(
        `/api/study/media/products/${encodeURIComponent(product.assetId)}?${query}`,
        { ...product, signal },
      );
      const body = product.mime.startsWith('text/') ? await blob.text() : null;
      if (signal?.aborted) return;
      const next = URL.createObjectURL(blob);
      ownedUrl.current = next;
      setUrl(next);
      setText(body);
    } catch (caught) {
      if (!signal?.aborted) setError(describeApiError(caught));
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  };
  return (
    <div>
      <button type="button" className="btn" disabled={busy || !!url} onClick={() => void open()}>
        {busy ? '读取与核验中…' : '查看实际产物'} · {product.mime} · {product.byteLength} 字节
      </button>
      {url ? (
        <>
          {product.kind === 'image' ? (
            <img
              src={url}
              alt="待人工核对的生成图片"
              style={{ maxWidth: '100%', maxHeight: 480 }}
            />
          ) : product.kind === 'video' ? (
            <video
              controls
              src={url}
              ref={(element) => {
                player.current = element;
              }}
              style={{ maxWidth: '100%' }}
            />
          ) : product.kind === 'tts' ? (
            <audio
              controls
              src={url}
              ref={(element) => {
                player.current = element;
              }}
            />
          ) : (
            <pre style={{ whiteSpace: 'pre-wrap' }}>{text}</pre>
          )}
          {product.kind === 'tts' || product.kind === 'video' ? (
            <label>
              播放速度
              <select
                defaultValue="1"
                onChange={(event) => {
                  if (player.current) player.current.playbackRate = Number(event.target.value);
                }}
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                  <option key={rate} value={rate}>
                    {rate} 倍
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <a
            className="btn"
            href={url}
            download={`${product.assetId}.${product.kind === 'asr' ? 'txt' : product.mime === 'image/png' ? 'png' : product.mime === 'image/jpeg' ? 'jpg' : product.mime === 'video/mp4' ? 'mp4' : product.mime === 'audio/wav' ? 'wav' : product.mime === 'audio/mpeg' ? 'mp3' : 'bin'}`}
          >
            下载已核验文件
          </a>
        </>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}
