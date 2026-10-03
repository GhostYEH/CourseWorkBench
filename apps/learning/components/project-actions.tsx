'use client';

import { Notice } from './ui';

import { useEffect, useRef, useState } from 'react';

type ProjectAction = 'create' | 'open' | 'close';

const LABELS: Record<ProjectAction, string> = {
  create: '新建项目',
  open: '打开项目',
  close: '关闭项目',
};

/** Native project lifecycle controls shared by the empty state and workbench. */
export const ProjectActions = ({ mode }: { mode: 'choose' | 'manage' }) => {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<ProjectAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    setAvailable(Boolean(window.sewNative));
  }, []);

  const run = async (action: ProjectAction) => {
    if (running.current) return;
    const bridge = window.sewNative;
    if (!bridge) {
      setAvailable(false);
      return;
    }

    running.current = true;
    setBusy(action);
    setError(null);
    try {
      if (action === 'create') {
        const project = await bridge.projectCreate();
        if (!project) return;
      } else if (action === 'open') {
        const project = await bridge.projectOpen();
        if (!project) return;
      } else {
        await bridge.projectClose();
      }

      // A full request avoids reusing an RSC payload from the previous project session.
      window.location.assign(action === 'close' ? '/no-project' : '/workbench');
    } catch {
      setError('项目操作失败，请确认所选目录可访问后重试。');
    } finally {
      running.current = false;
      setBusy(null);
    }
  };

  const actions: ProjectAction[] = mode === 'choose' ? ['create', 'open'] : ['create', 'open', 'close'];

  return (
    <div>
      <div className="row-inline" aria-busy={busy !== null}>
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            className={action === 'create' ? 'btn btn-primary' : 'btn'}
            onClick={() => void run(action)}
            disabled={busy !== null || available === false}
          >
            {busy === action ? `${LABELS[action]}中…` : LABELS[action]}
          </button>
        ))}
      </div>
      {available === false ? (
        <Notice tone="pending" role="status" style={{ marginTop: 'var(--sew-space-3)' }}>
          当前环境没有桌面项目管理能力，请在桌面应用中创建或打开项目。
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error" role="alert" style={{ marginTop: 'var(--sew-space-3)' }}>
          {error}
        </Notice>
      ) : null}
    </div>
  );
};
