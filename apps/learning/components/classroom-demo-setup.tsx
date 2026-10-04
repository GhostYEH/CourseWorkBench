'use client';

import { apiResponses } from '@sew/study-contracts';

import { Notice } from './ui';

import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/client';

/** Importing the author's demo is an explicit action, never a page-read side effect. */
export const ClassroomDemoSetup = ({ projectId, generation }: { projectId: string; generation: number }) => {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setReady(true); }, []);
  const initialize = async (): Promise<void> => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/api/maic/demo', apiResponses.classroomDemo, {
        method: 'POST',
        body: JSON.stringify({ scope: { projectId, generation }, confirmDemoImport: true }),
      });
      window.location.reload();
    } catch {
      setError('演示导入失败，请确认当前项目仍打开且来源可用。');
      setBusy(false);
    }
  };
  return (
    <Notice tone="pending">
      <p>尚未导入演示课堂。本功能使用上游幻灯片渲染器与自建课堂宿主，完整 OpenMAIC 课堂尚未接入。</p>
      <p>以下操作会向当前项目添加编者审核的演示材料、知识与测验题。它们不是正式考纲或真题；如需独立试用，请先新建演示项目。</p>
      <button type="button" className="btn btn-primary" disabled={!ready || busy} data-demo-import onClick={() => void initialize()}>
        {busy ? '正在导入演示…' : '确认将演示材料与编者审核记录导入当前项目'}
      </button>
      {error && <p role="alert">{error}</p>}
    </Notice>
  );
};
