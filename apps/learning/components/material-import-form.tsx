'use client';

import { Notice } from './ui';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, describeApiError } from '../lib/client';

/** 导入材料。文本直接粘贴或从原生选择器授权文件；两条路径走同一套规范化与指纹。 */
export const MaterialImportForm = ({ projectId, generation }: { projectId: string; generation: number }) => {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [readableLocation, setReadableLocation] = useState('');
  const [materialType, setMaterialType] = useState<'txt' | 'md'>('md');
  // 导入模式用显式状态表达，不从正文前缀字符串推断。
  const [mode, setMode] = useState<'file' | 'text'>('text');
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [rawText, setRawText] = useState('');
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
    setMaterialType(file.name.endsWith('.md') ? 'md' : 'txt');
    setSourcePath(file.path);
    setMode('file');
    setError(null);
  };

  const useTextMode = () => {
    setMode('text');
    setSourcePath(null);
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
    if (mode === 'file' && !sourcePath) {
      setError('尚未选择已授权文件，请先点击「从本机选择文件」。');
      return;
    }
    setBusy(true);
    try {
      const shared = {
        scope: { projectId, generation },
        displayName,
        type: materialType,
        readableLocation,
      };
      const body =
        mode === 'file'
          ? { ...shared, mode: 'file' as const, sourcePath: sourcePath ?? '' }
          : { ...shared, mode: 'text' as const, rawText };
      const data = await apiFetch<{
        material: { displayName: string; revision: number };
        segments: unknown[];
        invalidated: unknown[];
      }>('/api/study/materials', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setMessage(
        `已导入 ${data.material.displayName} r${data.material.revision}，共 ${data.segments.length} 段` +
          (data.invalidated.length > 0 ? `；${data.invalidated.length} 个知识点因版本变化转为已失效` : ''),
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
        首版支持 UTF-8 编码的 txt / md，编码错误或空正文会拒绝导入。程序移除开头 BOM、换行转换为 LF，切分段落并计算 SHA-256 指纹；
        重新导入同一名称的材料会产生新版本，旧版本保留。
        从本机选择文件时还会原样归档该文件的字节与 SHA-256，供后续按段落打开原文；粘贴导入没有原文件，会明确标记为未归档。
      </p>
      <div className="row-inline">
        <div className="field" style={{ flex: '1 1 220px' }}>
          <label htmlFor="material-name">材料名称</label>
          <input id="material-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
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
      <div className="row-inline">
        <button type="button" className="btn btn-primary" data-material-import-submit onClick={submit} disabled={!ready || busy || pending}>
          {busy ? '导入中…' : '导入并切分段落'}
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
