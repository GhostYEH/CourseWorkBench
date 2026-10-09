'use client';
import { useEffect, useRef, useState } from 'react';
import { MATERIAL_ORIGINAL_MIMES, type MaterialOriginalReceipt } from '@sew/study-contracts';
import { fetchVerifiedArtifact } from '../lib/verified-artifact';
import { describeApiError } from '../lib/client';
import { Notice } from './ui';

export function MaterialBinaryOriginal({
  projectId,
  generation,
  receipt,
}: {
  projectId: string;
  generation: number;
  receipt: MaterialOriginalReceipt;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, [projectId, generation, receipt.materialId, receipt.revision]);
  const download = async () => {
    if (busy) return;
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) return;
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        projectId,
        generation: String(generation),
        materialId: receipt.materialId,
        revision: String(receipt.revision),
        sha256: receipt.sourceSha256,
      });
      const blob = await fetchVerifiedArtifact(`/api/study/materials/original?${query}`, {
        sha256: receipt.sourceSha256,
        byteLength: receipt.sourceByteLength,
        mime: MATERIAL_ORIGINAL_MIMES[receipt.format],
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = receipt.originalName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) {
      if (!controller.signal.aborted) setError(describeApiError(caught));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <section aria-label="导入文档原件">
      <p>
        原件 {receipt.originalName} 已归档，{receipt.sourceByteLength}{' '}
        字节。段落定位对应提取文本；原件位置按页、幻灯片或工作表标记。
      </p>
      <button type="button" className="btn" disabled={busy} onClick={() => void download()}>
        核验并下载原件
      </button>
      <details>
        <summary>提取位置</summary>
        <ol>
          {receipt.locations.map((location, index) => (
            <li key={`${location.ordinal}:${index}`}>{location.label}</li>
          ))}
        </ol>
      </details>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </section>
  );
}
