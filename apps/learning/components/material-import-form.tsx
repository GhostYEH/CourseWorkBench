'use client';

import { Notice } from './ui';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, describeApiError } from '../lib/client';

const SAMPLE = [
  '# 人教版必修一 第三章 函数的基本性质',
  '',
  '函数的单调性：设函数 f(x) 的定义域为 I，如果对于定义域 I 内某个区间 D 上的任意两个自变量的值 x1、x2，当 x1 < x2 时，都有 f(x1) < f(x2)，那么就说函数 f(x) 在区间 D 上是增函数。',
  '',
  '判断单调性的基本步骤是取值、作差、变形、定号、下结论。',
].join('\n');

/** 导入材料。文本直接粘贴或从原生选择器授权文件；两条路径走同一套规范化与指纹。 */
export const MaterialImportForm = ({ projectId, generation }: { projectId: string; generation: number }) => {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('必修一第三章.md');
  const [readableLocation, setReadableLocation] = useState('人教版必修一 第三章');
  const [materialType, setMaterialType] = useState<'txt' | 'md'>('md');
  // 导入模式用显式状态表达，不从正文前缀字符串推断。
  const [mode, setMode] = useState<'file' | 'text'>('text');
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [rawText, setRawText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

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
    setError(null);
    setMessage(null);
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
          : { ...shared, mode: 'text' as const, rawText: rawText || SAMPLE };
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
        首版支持 txt / md。导入时程序统一 UTF-8、移除开头 BOM、换行转换为 LF，切分段落并计算 SHA-256 指纹；
        重新导入同一名称的材料会产生新版本，旧版本保留。
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
        <label htmlFor="material-text">材料正文（留空则使用示例节选）</label>
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
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || pending}>
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
