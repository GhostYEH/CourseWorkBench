'use client';

import { apiResponses } from '@sew/study-contracts';

/**
 * 角色档案面板（STYLE-01）。
 *
 * 只配置表达方式：名称、人格提示与讲解方式。面板上的权限是服务端按 kind 派生的
 * 只读事实，界面上没有可编辑的权限输入，客户端提交权限字段会被合同直接拒绝。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  MAX_PEER_PROFILES,
  ROLE_EXPLANATION,
  ROLE_KIND_LABEL,
  type RoleExplanation,
  type RoleKind,
  type RoleProfileDto,
} from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { apiFetch, describeApiError } from '../lib/client';

interface ProfileDraft {
  profileId: string | null;
  kind: RoleKind;
  name: string;
  persona: string;
  explanation: RoleExplanation;
}

const EXPLANATION_LABEL: Record<RoleExplanation, string> = {
  intuitive: '直观解释',
  rigorous: '严格定义优先',
  concise: '简洁要点',
};

const draftOf = (profile: RoleProfileDto | null, kind: RoleKind = 'teacher'): ProfileDraft => ({
  profileId: profile?.profileId ?? null,
  kind: profile?.kind ?? kind,
  name: profile?.name ?? (kind === 'teacher' ? '教师' : '同学'),
  persona: profile?.persona ?? '',
  explanation: profile?.explanation ?? 'intuitive',
});

export const RoleProfiles = ({
  projectId,
  generation,
  profiles,
  configDigest,
}: {
  projectId: string;
  generation: number;
  profiles: RoleProfileDto[];
  configDigest: string | null;
}): ReactNode => {
  const router = useRouter();
  const [draft, setDraft] = useState<ProfileDraft>(() => draftOf(profiles.find((item) => item.kind === 'teacher') ?? null));
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const peerCount = profiles.filter((profile) => profile.kind === 'peer').length;

  const call = async (body: Record<string, unknown>, successText: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await apiFetch('/api/study/roles', apiResponses.roleWrite, { method: 'POST', body: JSON.stringify({ scope: { projectId, generation }, ...body }) });
      setNote(successText);
      router.refresh();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    const fields = { name: draft.name, persona: draft.persona, explanation: draft.explanation };
    if (draft.profileId === null) {
      void call({ action: 'create', kind: draft.kind, ...fields }, `已添加${ROLE_KIND_LABEL[draft.kind]}档案。`);
      return;
    }
    void call({ action: 'update', profileId: draft.profileId, ...fields }, '档案已更新，配置版本号随之递增。');
  };

  const remove = (profileId: string): void => {
    void call({ action: 'delete', profileId }, '已删除该档案；权限位不受影响，因为它从来不是档案里的字段。');
  };

  return (
    <div className="card">
      <h2>角色档案</h2>
      <p className="secondary">
        教师与 AI 同学的讲解风格在这里配置。权限由系统按角色类型固定：同学没有白板写权限，也不能代表本人作答，
        AI 身份始终可见。改这些设置不会改变任何学科事实或权限边界。
      </p>

      {profiles.length === 0 ? (
        <Empty>还没有角色档案。未配置时 run 会如实记录「角色配置：未配置」。</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>类型</th>
              <th>名称</th>
              <th>讲解方式</th>
              <th>系统权限（只读）</th>
              <th>版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile) => (
              <tr key={profile.profileId}>
                <td>{ROLE_KIND_LABEL[profile.kind]}</td>
                <td>{profile.name}</td>
                <td>{EXPLANATION_LABEL[profile.explanation]}</td>
                <td className="mono">
                  {`白板写=${profile.permissions.whiteboardWrite ? '可' : '否'} · 代答本人=${profile.permissions.answerAsLearner ? '可' : '否'} · AI 身份可见=始终`}
                </td>
                <td className="mono">v{profile.configVersion}</td>
                <td>
                  <span className="row-inline">
                    <button type="button" className="btn btn-ghost" onClick={() => setDraft(draftOf(profile))} disabled={busy}>
                      编辑
                    </button>
                    {profile.kind === 'peer' ? (
                      <button type="button" className="btn btn-ghost" onClick={() => remove(profile.profileId)} disabled={busy}>
                        删除
                      </button>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row-inline">
        <div className="field" style={{ flex: '0 0 140px' }}>
          <label htmlFor="role-kind">类型</label>
          <select
            id="role-kind"
            value={draft.kind}
            disabled={draft.profileId !== null || peerCount >= MAX_PEER_PROFILES}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value as RoleKind })}
          >
            <option value="teacher">AI 教师</option>
            <option value="peer">AI 同学</option>
          </select>
        </div>
        <div className="field" style={{ flex: '1 1 160px' }}>
          <label htmlFor="role-name">名称</label>
          <input id="role-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </div>
        <div className="field" style={{ flex: '0 0 160px' }}>
          <label htmlFor="role-explanation">讲解方式</label>
          <select
            id="role-explanation"
            value={draft.explanation}
            onChange={(event) => setDraft({ ...draft, explanation: event.target.value as RoleExplanation })}
          >
            {ROLE_EXPLANATION.map((option) => (
              <option key={option} value={option}>
                {EXPLANATION_LABEL[option]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="role-persona">人格提示（不超过 300 字）</label>
        <textarea id="role-persona" value={draft.persona} onChange={(event) => setDraft({ ...draft, persona: event.target.value })} />
        <span className="hint">只影响讲解措辞；已核实知识、来源与判分规则不受它影响。</span>
      </div>
      <div className="row-inline">
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={busy || !draft.name.trim() || (draft.profileId === null && draft.kind === 'peer' && peerCount >= MAX_PEER_PROFILES)}
        >
          {draft.profileId === null ? '添加档案' : '保存修改'}
        </button>
        {draft.profileId !== null ? (
          <button type="button" className="btn btn-ghost" onClick={() => setDraft(draftOf(null, 'teacher'))} disabled={busy}>
            改为新建
          </button>
        ) : null}
      </div>
      <p className="muted mono">
        当前配置摘要：{configDigest ? `${configDigest.slice(0, 16)}…` : '未配置'} · 同学 {peerCount}/{MAX_PEER_PROFILES}
      </p>
      {note ? <Notice tone="verified">{note}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
};
