'use client';

import { useCallback, useEffect, useState } from 'react';
import { proSessionResponseSchema, proSessionsViewSchema } from '@sew/study-contracts';
import { apiFetch, describeApiError } from '../lib/client';

const responseSchema = proSessionResponseSchema;
type Scope = { projectId: string; generation: number };
type Skill = {
  skillId: string;
  title: string;
  description: string;
  source: 'builtin' | 'custom';
  enabled: boolean;
};
type Message = {
  messageId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName: string | null;
};
type ProTask = { taskId: string; status: string; candidateTaskId: string | null };
type CustomSkill = {
  skillId: string;
  requestId: string;
  revision: number;
  name: string;
  title: string;
  description: string;
  content: string;
  enabled: boolean;
};
type ProSession = {
  sessionId: string;
  title: string;
  revision: number;
  status: string;
  messages: Message[];
  skills: Skill[];
  tasks: ProTask[];
  toolCalls: Array<{ toolCallId: string; tool: string; status: string; result: string | null }>;
};
const newRequestId = () => `pro-ui-${crypto.randomUUID()}`;

export const ProSessionPanel = ({ scope }: { scope: Scope }) => {
  const [sessions, setSessions] = useState<ProSession[]>([]);
  const [selected, setSelected] = useState('');
  const [title, setTitle] = useState('新学习会话');
  const [draft, setDraft] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [bundleDigest, setBundleDigest] = useState('');
  const [customSkills, setCustomSkills] = useState<CustomSkill[]>([]);
  const [skillName, setSkillName] = useState('');
  const [skillTitle, setSkillTitle] = useState('');
  const [skillDescription, setSkillDescription] = useState('');
  const [skillContent, setSkillContent] = useState('');
  const [expectedPlanRevision, setExpectedPlanRevision] = useState('0');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedSession = sessions.find((item) => item.sessionId === selected) ?? null;

  const refresh = useCallback(async () => {
    const data = await apiFetch(
      `/api/study/pro?projectId=${encodeURIComponent(scope.projectId)}&generation=${scope.generation}`,
      proSessionsViewSchema,
    );
    const next = data.sessions;
    setSessions(next);
    setCustomSkills(data.skills);
    setSelected((previous) =>
      next.some((item) => item.sessionId === previous) ? previous : (next[0]?.sessionId ?? ''),
    );
  }, [scope.projectId, scope.generation]);
  useEffect(() => {
    void refresh().catch((cause) => setError(describeApiError(cause)));
  }, [refresh]);

  const send = async (action: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      await apiFetch('/api/study/pro', responseSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, requestId: newRequestId(), ...action }),
      });
      await refresh();
    } catch (cause) {
      setError(describeApiError(cause));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await apiFetch('/api/study/pro', responseSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope, requestId: newRequestId(), action: 'create', title }),
      });
      await refresh();
      if (result.detail) setSelected(result.detail.sessionId);
    } catch (cause) {
      setError(describeApiError(cause));
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (
      !selectedSession ||
      !draft.trim() ||
      !bundleId.trim() ||
      !/^[a-f0-9]{64}$/.test(bundleDigest)
    ) {
      setError('请先选择会话，填写冻结材料包 ID 与 64 位摘要，再输入消息。');
      return;
    }
    const content = draft;
    setDraft('');
    await send({
      action: 'send',
      sessionId: selectedSession.sessionId,
      expectedRevision: selectedSession.revision,
      content,
      bundleId,
      bundleDigest,
      skillIds: selectedSession.skills
        .filter((skill) => skill.enabled)
        .map((skill) => skill.skillId),
    });
  };
  const createCustomSkill = async () => {
    await send({
      action: 'skill-create',
      name: skillName,
      title: skillTitle,
      description: skillDescription,
      content: skillContent,
    });
    setSkillName('');
    setSkillTitle('');
    setSkillDescription('');
    setSkillContent('');
  };
  const setSkillEnabled = async (skillId: string, enabled: boolean) => {
    if (!selectedSession) return;
    await send({
      action: 'skill-toggle',
      sessionId: selectedSession.sessionId,
      expectedRevision: selectedSession.revision,
      skillId,
      enabled,
    });
  };
  const review = async (task: ProTask, decision: 'approved' | 'rejected') => {
    if (!selectedSession || !task.candidateTaskId) return;
    const courseware = !task.candidateTaskId.startsWith('gp_');
    await send({
      action: 'review',
      sessionId: selectedSession.sessionId,
      expectedRevision: selectedSession.revision,
      taskId: task.taskId,
      candidateTaskId: task.candidateTaskId,
      decision,
      note: decision === 'approved' ? '本人查看候选后确认' : '本人拒绝该候选',
      ...(courseware
        ? { expectedPlanRevision: Number(expectedPlanRevision), override: false }
        : {}),
    });
  };

  return (
    <section className="card">
      <h2>Pro 学习会话</h2>
      <p>
        会话、消息、技能开关与任务结果保存在当前项目的私有 SQLite
        分区。模型回复只作为草案；工具执行与候选应用需本人明确操作。
      </p>
      <div className="row-inline">
        <label>
          会话
          <select value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="">选择会话</option>
            {sessions.map((item) => (
              <option key={item.sessionId} value={item.sessionId}>
                {item.title} · {item.status}
              </option>
            ))}
          </select>
        </label>
        <label>
          新会话名称
          <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <button type="button" disabled={busy} onClick={() => void create()}>
          新建会话
        </button>
      </div>
      {selectedSession ? (
        <>
          <div className="row-inline">
            <label>
              冻结材料包 ID
              <input value={bundleId} onChange={(event) => setBundleId(event.target.value)} />
            </label>
            <label>
              材料包 SHA-256
              <input
                value={bundleDigest}
                onChange={(event) => setBundleDigest(event.target.value)}
              />
            </label>
          </div>
          <div className="card">
            <h3>固定技能快照</h3>
            <div className="row-inline">
              {selectedSession.skills.map((skill) => (
                <label key={skill.skillId} title={skill.description}>
                  <input
                    type="checkbox"
                    checked={skill.enabled}
                    onChange={(event) =>
                      void send({
                        action: 'skill-toggle',
                        sessionId: selectedSession.sessionId,
                        expectedRevision: selectedSession.revision,
                        skillId: skill.skillId,
                        enabled: event.target.checked,
                      })
                    }
                  />
                  {skill.title}
                </label>
              ))}
            </div>
            <p className="muted">
              技能正文只作为低优先级参考资料，不授予 shell、文件或网络访问权。
            </p>
          </div>
          <div className="card">
            <h3>自定义技能资料</h3>
            <div className="row-inline">
              {customSkills.map((skill) => (
                <div key={skill.skillId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={
                        selectedSession.skills.find((item) => item.skillId === skill.skillId)
                          ?.enabled ?? false
                      }
                      onChange={(event) =>
                        void setSkillEnabled(skill.skillId, event.target.checked)
                      }
                    />
                    {skill.title}
                  </label>{' '}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void send({
                        action: 'skill-delete',
                        skillId: skill.skillId,
                        expectedRevision: skill.revision,
                      })
                    }
                  >
                    删除
                  </button>{' '}
                  <button
                    type="button"
                    onClick={() => {
                      const blob = new Blob([JSON.stringify(skill, null, 2)], {
                        type: 'application/json',
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${skill.name}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    导出
                  </button>
                </div>
              ))}
            </div>
            <label>
              技能名称
              <input
                value={skillName}
                maxLength={80}
                onChange={(event) => setSkillName(event.target.value)}
              />
            </label>
            <label>
              标题
              <input
                value={skillTitle}
                maxLength={120}
                onChange={(event) => setSkillTitle(event.target.value)}
              />
            </label>
            <label>
              说明
              <input
                value={skillDescription}
                maxLength={500}
                onChange={(event) => setSkillDescription(event.target.value)}
              />
            </label>
            <label>
              正文资料（最多 12 KiB）
              <textarea
                rows={4}
                value={skillContent}
                maxLength={12000}
                onChange={(event) => setSkillContent(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !skillContent.trim()}
              onClick={() => void createCustomSkill()}
            >
              保存自定义技能
            </button>
          </div>
          <div className="card" aria-live="polite">
            {selectedSession.messages.map((message) => (
              <article key={message.messageId} className="pro-message">
                <strong>
                  {message.role === 'user'
                    ? '本人'
                    : message.role === 'tool'
                      ? `工具 ${message.toolName ?? ''}`
                      : 'Pro'}
                </strong>
                <p>{message.content}</p>
              </article>
            ))}
          </div>
          {selectedSession.toolCalls
            .filter((call) => call.status === 'proposed')
            .map((call) => (
              <div className="notice" key={call.toolCallId}>
                工具建议 {call.tool}（{call.toolCallId}）
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void send({
                      action: 'execute-tool',
                      sessionId: selectedSession.sessionId,
                      expectedRevision: selectedSession.revision,
                      toolCallId: call.toolCallId,
                    })
                  }
                >
                  本人确认并执行
                </button>
              </div>
            ))}
          {selectedSession.tasks
            .filter((task) => task.status === 'waiting_review' && task.candidateTaskId)
            .map((task) => (
              <div className="notice" key={task.taskId}>
                <p>候选 {task.candidateTaskId} 已生成但未应用。请先查看对应课程或课件候选。</p>
                {!task.candidateTaskId!.startsWith('gp_') ? (
                  <label>
                    我查看到的当前计划修订
                    <input
                      type="number"
                      min={0}
                      value={expectedPlanRevision}
                      onChange={(event) => setExpectedPlanRevision(event.target.value)}
                    />
                  </label>
                ) : null}
                <button type="button" disabled={busy} onClick={() => void review(task, 'approved')}>
                  本人审核通过
                </button>
                <button type="button" disabled={busy} onClick={() => void review(task, 'rejected')}>
                  本人拒绝
                </button>
              </div>
            ))}
          <label className="field">
            消息
            <textarea
              value={draft}
              maxLength={4000}
              rows={4}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button type="button" disabled={busy || !draft.trim()} onClick={() => void submit()}>
            {busy ? '处理中…' : '发送'}
          </button>
        </>
      ) : (
        <p>创建一个会话后即可开始。</p>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
};
