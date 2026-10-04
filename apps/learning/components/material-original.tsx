'use client';

/**
 * 归档原文查看与打开。
 *
 * 界面高亮用服务返回的字符偏移，权威定位仍是归档字节区间；打开原文副本由主进程
 * 复验路径归属后交给系统，渲染层不接触磁盘路径。原文未归档时明确说明，不伪造视图。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { MaterialRawViewDto } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';
import { Notice } from './ui';

interface MaterialOriginalProps {
  projectId: string;
  generation: number;
  materialId: string;
  revision: number;
  segmentId?: string | undefined;
}

export const MaterialOriginal = ({
  projectId, generation, materialId, revision, segmentId,
}: MaterialOriginalProps): ReactNode => {
  const [view, setView] = useState<MaterialRawViewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ revision: String(revision) });
      if (segmentId) query.set('segmentId', segmentId);
      setView(await apiFetch<MaterialRawViewDto>(`/api/study/materials/${materialId}/raw?${query.toString()}`));
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  const openOriginal = async (): Promise<void> => {
    const bridge = window.sewNative;
    if (!bridge) {
      setError('当前不在桌面壳中运行，无法调用系统打开原文；可先查看已归档的原文文本。');
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await bridge.openMaterialOriginal({
        scope: { projectId, generation },
        materialId,
        revision,
        ...(segmentId ? { segmentId } : {}),
      });
      setNote(
        result.lineStart !== null && result.lineEnd !== null
          ? `系统已打开原文副本${result.displayName ? `（${result.displayName}）` : ''}，该段位于第 ${result.lineStart}–${result.lineEnd} 行。`
          : '系统已打开原文副本。',
      );
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  const rawText = view?.rawText ?? null;
  const span = view?.segment ?? null;
  const archive = view?.archive;

  return (
    <div className="card">
      <h3>归档原文{segmentId ? ` · ${segmentId}` : ''}</h3>
      <div className="row-inline">
        <button type="button" className="btn" onClick={load} disabled={busy}>查看归档原文</button>
        <button type="button" className="btn btn-primary" onClick={openOriginal} disabled={busy}>
          用系统程序打开原文副本
        </button>
      </div>
      <p className="hint">
        原文按导入时的字节原样保存（含开头 BOM 与原始换行），与已保存的规范化段落属于同一材料版本。
        打开时会在项目内写一份只读副本，随项目一起备份。
      </p>
      {archive?.state === 'absent' ? (
        <Notice tone="pending">
          {archive.reason === 'text_import'
            ? '该版本由粘贴导入，没有原始文件可归档，因此只能查看规范化段落。'
            : '该版本在原文归档功能之前导入，原始字节未保存；重新导入同一文件即可归档原文。'}
        </Notice>
      ) : null}
      {archive?.state === 'archived' ? (
        <p className="muted mono">
          {archive.originalName ?? '未登记文件名'} · {archive.byteLength} 字节 · SHA-256 {archive.sha256.slice(0, 12)}…
        </p>
      ) : null}
      {rawText !== null ? (
        span ? (
          <pre className="raw-source" aria-label={`段落 ${span.segmentId} 在归档原文中的位置`}>
            {rawText.slice(0, span.startChar)}
            <mark>{rawText.slice(span.startChar, span.endChar)}</mark>
            {rawText.slice(span.endChar)}
          </pre>
        ) : (
          <pre className="raw-source">{rawText}</pre>
        )
      ) : null}
      {span ? (
        <p className="muted">
          第 {span.lineStart}–{span.lineEnd} 行 · 字节 {span.startByte}–{span.endByte} ·
          {' '}高亮文本与登记段落指纹同源于同一份归档字节。
        </p>
      ) : null}
      {note ? <Notice tone="verified">{note}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
};
