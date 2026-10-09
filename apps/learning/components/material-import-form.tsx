'use client';

import { apiResponses } from '@sew/study-contracts';

import { Notice } from './ui';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, describeApiError } from '../lib/client';
import {
  materialExtractionPreviewSchema,
  type MaterialExtractionPreview,
} from '../lib/material-extraction-contract';

/** 导入材料。文本直接粘贴或从原生选择器授权文件；两条路径走同一套规范化与指纹。 */
export const MaterialImportForm = ({
  projectId,
  generation,
}: {
  projectId: string;
  generation: number;
}) => {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [readableLocation, setReadableLocation] = useState('');
  const [materialType, setMaterialType] = useState<'txt' | 'md'>('md');
  // 导入模式用显式状态表达，不从正文前缀字符串推断。
  const [mode, setMode] = useState<'file' | 'text' | 'document'>('text');
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [rawText, setRawText] = useState('');
  const [preview, setPreview] = useState<MaterialExtractionPreview | null>(null);
  const [previewReviewed, setPreviewReviewed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const pickFile = async () => {
    const bridge = window.sewNative;
    if (!bridge) {
      setError('当前不在桌面壳中运行，无法调用原生文件选择；可直接粘贴文本。');
      return;
    }
    const picked = await bridge.pickMaterials();
    const file = picked.files[0];
    if (!file) return;
    setDisplayName(file.name);
    const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
    const supportedText = extension === 'md' || extension === 'txt';
    setMaterialType(extension === 'txt' ? 'txt' : 'md');
    setSourcePath(file.path);
    setMode(supportedText ? 'file' : 'document');
    setPreview(null);
    setPreviewReviewed(false);
    setError(null);
  };

  const useTextMode = () => {
    setMode('text');
    setSourcePath(null);
    setPreview(null);
    setPreviewReviewed(false);
  };

  const submit = async () => {
    if (!ready || busy || pending) return;
    setError(null);
    setMessage(null);
    if (!displayName.trim()) {
      setError('请填写实际材料名称。');
      return;
    }
    if (mode === 'text' && !rawText.trim()) {
      setError('材料正文为空，请粘贴实际材料内容。');
      return;
    }
    if ((mode === 'file' || mode === 'document') && !sourcePath) {
      setError('尚未选择已授权文件，请先点击「从本机选择文件」。');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'document' && !preview) {
        const extracted = await apiFetch(
          '/api/study/materials/extract',
          materialExtractionPreviewSchema,
          {
            method: 'POST',
            body: JSON.stringify({ scope: { projectId, generation }, sourcePath }),
          },
        );
        setPreview(extracted);
        setPreviewReviewed(false);
        setMessage('已提取可识别内容；请逐段核对位置与表格/公式，再明确确认导入。');
        return;
      }
      const shared = {
        scope: { projectId, generation },
        displayName,
        type: materialType,
        readableLocation,
      };
      if (mode === 'document') {
        if (!preview || !previewReviewed) {
          setError('请先查看提取预览并勾选确认。');
          return;
        }
        const data = await apiFetch(
          '/api/study/materials/import-extracted',
          apiResponses.materialImport,
          {
            method: 'POST',
            body: JSON.stringify({
              scope: { projectId, generation },
              extractionId: preview.extractionId,
              displayName,
              ...(readableLocation ? { readableLocation } : {}),
            }),
          },
        );
        setMessage(
          `已导入 ${data.material.displayName} r${data.material.revision}，共 ${data.segments.length} 段；原二进制已归档，可从材料版本查看提取来源。`,
        );
        setPreview(null);
        setPreviewReviewed(false);
        startTransition(() => router.refresh());
        return;
      }
      const body =
        mode === 'file'
          ? { ...shared, mode: 'file' as const, sourcePath: sourcePath ?? '' }
          : { ...shared, mode: 'text' as const, rawText };
      const data = await apiFetch('/api/study/materials', apiResponses.materialImport, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setMessage(
        `已导入 ${data.material.displayName} r${data.material.revision}，共 ${data.segments.length} 段` +
          (data.invalidated.length > 0
            ? `；${data.invalidated.length} 个知识点因版本变化转为已失效`
            : ''),
      );
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>导入材料</h2>
      <p className="secondary">
        支持 UTF-8 txt / md，以及含文字层的 PDF、DOCX、PPTX、XLSX。Office/PDF 会先生成只读提取预览；
        请核对段落位置、表格与公式后再确认。PDF 扫描件不做
        OCR，宏、外部链接、图片、音视频和嵌入对象不会执行或识别。
        确认后归档原二进制和提取文本，引用段落指向提取文本，并保留页/幻灯片/工作表定位；重新导入同名材料会产生新版本。
      </p>
      <div className="row-inline">
        <div className="field" style={{ flex: '1 1 220px' }}>
          <label htmlFor="material-name">材料名称</label>
          <input
            id="material-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <div className="field" style={{ flex: '1 1 180px' }}>
          <label htmlFor="material-location">可读位置（章节 / 题号）</label>
          <input
            id="material-location"
            value={readableLocation}
            onChange={(event) => setReadableLocation(event.target.value)}
          />
        </div>
        <div className="field" style={{ flex: '0 0 120px' }}>
          <label htmlFor="material-type">类型</label>
          <select
            id="material-type"
            value={materialType}
            onChange={(event) => setMaterialType(event.target.value === 'txt' ? 'txt' : 'md')}
          >
            <option value="md">md</option>
            <option value="txt">txt</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="material-text">材料正文</label>
        <textarea
          id="material-text"
          value={mode === 'file' ? '' : rawText}
          disabled={mode === 'file'}
          placeholder="粘贴考纲或教材节选；也可点击下方按钮从本机选择文件"
          onChange={(event) => setRawText(event.target.value)}
        />
        <span className="hint">正文只用于建立证据版本，不会自动成为知识点。</span>
      </div>
      {mode === 'file' ? (
        <div className="field">
          <span className="hint">已授权文件（只读，导入时由本地服务读取）</span>
          <div className="mono secondary" style={{ wordBreak: 'break-all' }}>
            {sourcePath}
          </div>
        </div>
      ) : null}
      {mode === 'document' ? (
        <div className="card" data-material-extraction-preview>
          <p className="hint">
            已选择 {sourcePath?.split(/[\\/]/).at(-1)}
            。点击“提取并预览”后，服务会重新校验原件摘要；尚未确认导入。
          </p>
          {preview ? (
            <>
              <p className="mono secondary">
                {preview.source.format.toUpperCase()} · {preview.source.byteLength} 字节 · SHA-256{' '}
                {preview.source.sha256}
              </p>
              {preview.warnings.map((warning) => (
                <p className="hint" key={warning}>
                  {warning}
                </p>
              ))}
              <pre
                className="excerpt"
                style={{ maxHeight: '28rem', overflow: 'auto', whiteSpace: 'pre-wrap' }}
              >
                {preview.extractedText}
              </pre>
              <label className="row-inline">
                <input
                  type="checkbox"
                  checked={previewReviewed}
                  onChange={(event) => setPreviewReviewed(event.target.checked)}
                />
                我已核对提取文本与页/slide/sheet 位置，确认作为待审核材料导入
              </label>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="row-inline">
        <button
          type="button"
          className="btn btn-primary"
          data-material-import-submit
          onClick={submit}
          disabled={
            !ready ||
            busy ||
            pending ||
            (mode === 'document' && preview !== null && !previewReviewed)
          }
        >
          {busy
            ? mode === 'document' && !preview
              ? '提取中…'
              : '导入中…'
            : mode === 'document'
              ? preview
                ? '确认导入提取内容'
                : '提取并预览'
              : '导入并切分段落'}
        </button>
        <button type="button" className="btn" onClick={pickFile}>
          从本机选择文件
        </button>
        {mode === 'file' ? (
          <button type="button" className="btn btn-ghost" onClick={useTextMode}>
            改用粘贴文本
          </button>
        ) : null}
      </div>
      {message ? (
        <Notice tone="verified" style={{ marginTop: 'var(--sew-space-3)' }}>
          {message}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error" style={{ marginTop: 'var(--sew-space-3)' }}>
          {error}
        </Notice>
      ) : null}
    </div>
  );
};
