'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiResponses, type LearnerProfileDto } from '@sew/study-contracts';
import { ApiError, apiFetch, describeApiError } from '../lib/client';

export function LearnerProfile({ initialProfile, initialError = null }: {
  initialProfile: LearnerProfileDto | null; initialError?: string | null;
}) {
  const [profile, setProfile] = useState(initialProfile);
  const [name, setName] = useState(initialProfile?.displayName ?? '');
  const [busy, setBusy] = useState<'read' | 'save' | 'copy' | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [message, setMessage] = useState<string | null>(null);
  const active = useRef(false);
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { epoch.current += 1; controller.current?.abort(); }, []);

  const execute = async (kind: 'read' | 'save', action: (signal: AbortSignal) => Promise<LearnerProfileDto>) => {
    if (active.current) return;
    active.current = true; setBusy(kind); setError(null); setMessage(null);
    const started = epoch.current;
    const abort = new AbortController(); controller.current = abort;
    try {
      const next = await action(abort.signal);
      if (started !== epoch.current) return;
      setProfile(next); setName(next.displayName); setNeedsReload(false);
      setMessage(kind === 'save' ? '昵称已保存，UID 保持不变。' : '已重新读取个人档案。');
    } catch (caught) {
      if (started !== epoch.current || abort.signal.aborted) return;
      if (caught instanceof ApiError && caught.code === 'VERSION_CONFLICT') {
        setNeedsReload(true); setError('个人档案已更新，请重新读取后核对昵称再保存。');
      } else setError(describeApiError(caught));
    } finally {
      if (started === epoch.current) { active.current = false; setBusy(null); controller.current = null; }
    }
  };
  const reload = () => void execute('read', signal => apiFetch('/api/study/identity', apiResponses.learnerProfile, { signal }));
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!profile || needsReload || active.current) return;
    const displayName = name.trim();
    if (!displayName || displayName.length > 80) { setError('请填写 1 至 80 字的昵称。'); return; }
    void execute('save', signal => apiFetch('/api/study/identity', apiResponses.learnerProfile, {
      method: 'PUT', signal, body: JSON.stringify({ displayName, expectedRevision: profile.revision, expectedUid: profile.uid }),
    }));
  };
  const copy = async () => {
    if (!profile || active.current) return;
    active.current = true; setBusy('copy'); setError(null); setMessage(null);
    const started = epoch.current;
    try {
      await navigator.clipboard.writeText(profile.uid);
      if (started === epoch.current) setMessage('UID 已复制。');
    } catch {
      if (started === epoch.current) setError('暂时无法自动复制，请选中上方 UID 手动复制。');
    } finally {
      if (started === epoch.current) { active.current = false; setBusy(null); }
    }
  };

  return <section className="card" data-learner-profile>
    <h2>我的学习者身份</h2>
    <p>UID 属于你的个人档案。修改昵称、切换科目或重开应用都会保留同一个 UID。</p>
    {profile ? <>
      <div className="field"><label htmlFor="learner-uid">个人 UID</label>
        <input id="learner-uid" data-learner-uid readOnly value={profile.uid} onFocus={event => event.currentTarget.select()} />
      </div>
      <button className="btn" data-copy-uid type="button" disabled={busy !== null} onClick={() => void copy()}>复制 UID</button>
      <form onSubmit={save}>
        <div className="field"><label htmlFor="learner-display-name">昵称</label>
          <input id="learner-display-name" data-learner-name required maxLength={80} disabled={busy !== null || needsReload} value={name} onChange={event => setName(event.target.value)} />
        </div>
        <button className="btn btn-primary" data-save-learner-name type="submit" disabled={busy !== null || needsReload}>{busy === 'save' ? '正在保存…' : '保存昵称'}</button>
      </form>
      <p className="muted">个人档案版本 {profile.revision} · 创建于 {new Date(profile.createdAt).toISOString().slice(0, 10)}</p>
    </> : <p>个人档案暂时无法读取。原有学习记录不会因此被改为另一个 UID。</p>}
    <p role="status">尚未完成在线登记，当前不能通过 UID 邀请同学。UID 本身不能用于登录或验证身份。</p>
    <p className="muted">请保留个人档案数据。复制科目项目或数据库备份不会复制个人身份；跨设备身份恢复尚未接通。</p>
    <button className="btn" type="button" disabled={busy !== null} onClick={reload}>重新读取个人档案</button>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {message ? <p role="status" data-learner-profile-message>{message}</p> : null}
  </section>;
}
