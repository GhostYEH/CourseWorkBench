'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QuizContent, RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import { HttpRuntimeStore } from '@openmaic/storage/runtime/http';
import { apiFetch, getSessionToken, describeApiError } from '../../lib/client';

interface Scope {
  projectId: string;
  generation: number;
}

interface QuizPayload {
  payloadVersion: 1;
  phase: 'draft' | 'submitted' | 'reviewed';
  answers: Record<string, unknown>;
  results?: Array<{ questionId: string; correct: boolean; status?: string; earned?: number }>;
}

interface RuntimeView {
  session: RuntimeSession;
  lastSeq: number | null;
  payload?: QuizPayload;
}

interface AttemptResponse {
  attempt: { kind: string; masteryAfter: string | null };
  record: RuntimeRecord;
  deduplicated: boolean;
}

const isQuizPayload = (value: unknown): value is QuizPayload => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return payload.payloadVersion === 1 &&
    (payload.phase === 'draft' || payload.phase === 'submitted' || payload.phase === 'reviewed') &&
    typeof payload.answers === 'object' && payload.answers !== null && !Array.isArray(payload.answers);
};

const timestamp = (): string => new Date().toISOString();

const submitKey = async (input: {
  sessionId: string;
  questionId: string;
  answerText: string;
  processText: string;
}): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify([
    'sew-quiz-submit-v1',
    input.sessionId,
    input.questionId,
    input.answerText,
    input.processText,
  ]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `quiz-v1-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * Quiz lifecycle adapted from OpenMAIC QuizView/runtime.ts. Draft and submitted
 * facts use the upstream RuntimeStore contract; reviewed is produced only by
 * this app's server transaction, which binds source, checks the correct answer,
 * updates the personal attempt and appends the review receipt atomically.
 */
export function QuizSceneView({
  content,
  sceneId,
  stageId,
  scope,
  questionId,
  reviewedBy,
}: {
  content: QuizContent;
  sceneId: string;
  stageId: string;
  scope: Scope;
  questionId?: string;
  reviewedBy?: string;
}) {
  const question = content.questions[0];
  const dslQuestionId = question?.id ?? '';
  const store = useMemo(() => new HttpRuntimeStore({
    baseUrl: '/api/maic',
    headers: () => {
      const token = getSessionToken();
      return {
        ...(token ? { 'x-sew-session': token } : {}),
        'x-sew-project-id': scope.projectId,
        'x-sew-generation': String(scope.generation),
      };
    },
  }), [scope.generation, scope.projectId]);
  const [runtime, setRuntime] = useState<RuntimeView | null>(null);
  const [answer, setAnswer] = useState('');
  const [processText, setProcessText] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const epochRef = useRef(0);
  const runtimeRef = useRef<RuntimeView | null>(null);
  const appendTailRef = useRef<Promise<void>>(Promise.resolve());
  const lastDraftHashRef = useRef<string | null>(null);
  const updateRuntime = (next: RuntimeView | null): void => {
    runtimeRef.current = next;
    setRuntime(next);
  };

  const openAttempt = useCallback(async (startNew: boolean, isCurrent: () => boolean): Promise<void> => {
    setLoading(true);
    setError(null);
    if (startNew) updateRuntime(null);
    try {
      const identity = await apiFetch<{ learnerKey: string }>('/api/maic/runtime/learner-key', {
        headers: {
          'x-sew-project-id': scope.projectId,
          'x-sew-generation': String(scope.generation),
        },
      });
      if (!isCurrent()) return;
      const sessions = (await store.listSessions(stageId, identity.learnerKey))
        .filter((session) => session.kind === 'quizAttempt' && session.stageId === stageId)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      if (!isCurrent()) return;
      const candidateRecords = await Promise.all(sessions.map(async (session) => ({
        session,
        records: await store.listRecords(session.id, { sceneId }),
      })));
      if (!isCurrent()) return;
      const latest = candidateRecords.find(({ records }) => records.length > 0);
      if (latest && !startNew) {
        const record = latest.records.at(-1)!;
        const payload = isQuizPayload(record.payload) ? record.payload : undefined;
        updateRuntime({ session: latest.session, lastSeq: record.seq, payload });
        setAnswer(typeof payload?.answers[dslQuestionId] === 'string' ? payload.answers[dslQuestionId] as string : '');
        setProcessText(typeof payload?.answers[`${dslQuestionId}:process`] === 'string'
          ? payload.answers[`${dslQuestionId}:process`] as string
          : '');
        if (latest.session.status === 'completed' && payload?.phase === 'reviewed') {
          const result = payload.results?.find((item) => item.questionId === dslQuestionId);
          setFeedback(
            `服务端审核已保存${result ? `：${result.correct ? '正确' : '待复核或错误'}${typeof result.earned === 'number' ? `，得分 ${result.earned}` : ''}` : ''}。` +
            (latest.session.status === 'completed' ? '可关闭并重新打开课堂读回此记录。' : ''),
          );
        }
        setLoading(false);
        return;
      }

      const active = !startNew ? sessions.find((session) => session.status === 'active') : undefined;
      if (active) {
        const records = await store.listRecords(active.id, { sceneId });
        if (!isCurrent()) return;
        const record = records.at(-1);
        const payload = record && isQuizPayload(record.payload) ? record.payload : undefined;
        updateRuntime({ session: active, lastSeq: record?.seq ?? null, payload });
        setAnswer(typeof payload?.answers[dslQuestionId] === 'string' ? payload.answers[dslQuestionId] as string : '');
        setProcessText(typeof payload?.answers[`${dslQuestionId}:process`] === 'string'
          ? payload.answers[`${dslQuestionId}:process`] as string
          : '');
        setLoading(false);
        return;
      }

      const baseId = `quiz-attempt:${encodeURIComponent(stageId)}:${encodeURIComponent(sceneId)}:${encodeURIComponent(identity.learnerKey)}`;
      const timestampNow = timestamp();
      let created: RuntimeSession | undefined;
      for (let index = 0; index < 64; index += 1) {
        const id = index === 0 ? baseId : `${baseId}:retry:${index}`;
        const existing = await store.getSession(id);
        if (!isCurrent()) return;
        if (existing) {
          if (!startNew && existing.status === 'active') {
            const records = await store.listRecords(id, { sceneId });
            if (!isCurrent()) return;
            const record = records.at(-1);
            const payload = record && isQuizPayload(record.payload) ? record.payload : undefined;
            updateRuntime({ session: existing, lastSeq: record?.seq ?? null, payload });
            setAnswer(typeof payload?.answers[dslQuestionId] === 'string' ? payload.answers[dslQuestionId] as string : '');
            setProcessText(typeof payload?.answers[`${dslQuestionId}:process`] === 'string'
              ? payload.answers[`${dslQuestionId}:process`] as string
              : '');
            setLoading(false);
            return;
          }
          continue;
        }
        try {
          created = await store.createSession({
            id,
            kind: 'quizAttempt',
            stageId,
            learnerKey: identity.learnerKey,
            status: 'active',
            createdAt: timestampNow,
            updatedAt: timestampNow,
          });
          if (!isCurrent()) return;
          break;
        } catch (caught) {
          const raced = await store.getSession(id);
          if (!isCurrent()) return;
          if (!raced || raced.status !== 'active') throw caught;
          created = raced;
          break;
        }
      }
      if (!created) throw new Error('无法为本次测验创建课堂运行会话，请重试。');
      updateRuntime({ session: created, lastSeq: null });
      setAnswer('');
      setProcessText('');
      setFeedback(null);
    } catch (caught) {
      if (isCurrent()) setError(describeApiError(caught));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [dslQuestionId, sceneId, scope.generation, scope.projectId, stageId, store]);

  useEffect(() => {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    const isCurrent = () => epochRef.current === epoch;
    void openAttempt(false, isCurrent);
    return () => {
      if (epochRef.current === epoch) epochRef.current += 1;
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [openAttempt, store]);

  const answers = useMemo(() => ({
    [dslQuestionId]: answer,
    [`${dslQuestionId}:process`]: processText,
  }), [answer, dslQuestionId, processText]);

  useEffect(() => {
    if (!runtime || runtime.session.status !== 'active' || (runtime.payload && runtime.payload.phase !== 'draft') || loading || busy) return;
    const draftHash = JSON.stringify([runtime.session.id, sceneId, answers]);
    if (lastDraftHashRef.current === draftHash) return;
    const writerEpoch = epochRef.current;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      const write = appendTailRef.current.catch(() => {}).then(async () => {
        const latest = runtimeRef.current;
        if (epochRef.current !== writerEpoch || busyRef.current) return;
        if (!latest || latest.session.status !== 'active') return;
        const record = await store.appendRecord({
        id: crypto.randomUUID(),
        sessionId: latest.session.id,
        sceneId,
        createdAt: timestamp(),
        payload: { payloadVersion: 1, phase: 'draft', answers },
        }, { expectedLastSeq: latest.lastSeq });
        if (epochRef.current !== writerEpoch) return;
        if (runtimeRef.current?.session.id !== latest.session.id) return;
        lastDraftHashRef.current = draftHash;
        updateRuntime({ ...latest, lastSeq: record.seq, payload: { payloadVersion: 1, phase: 'draft', answers } });
      });
      appendTailRef.current = write;
      void write.catch((caught: unknown) => {
        if (epochRef.current === writerEpoch) setError(describeApiError(caught));
      });
    }, 350);
    return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
  }, [answers, busy, loading, runtime, sceneId, store]);

  const submit = async (): Promise<void> => {
    if (!runtime || !questionId || !dslQuestionId || !answer || busy) return;
    busyRef.current = true;
    setBusy(true);
    const submitEpoch = epochRef.current;
    setError(null);
    setFeedback(null);
    try {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      await appendTailRef.current.catch(() => {});
      const latest = runtimeRef.current;
      if (epochRef.current !== submitEpoch) return;
      if (!latest || latest.session.id !== runtime.session.id) throw new Error('课堂测验会话已切换，请重新读取后提交。');
      let lastSeq = latest.lastSeq;
      if (latest.payload?.phase !== 'submitted') {
        const submitted = await store.appendRecord({
          id: crypto.randomUUID(),
          sessionId: latest.session.id,
          sceneId,
          createdAt: timestamp(),
          payload: { payloadVersion: 1, phase: 'submitted', answers },
        }, { expectedLastSeq: lastSeq });
        if (epochRef.current !== submitEpoch) return;
        lastSeq = submitted.seq;
        updateRuntime({ ...latest, lastSeq, payload: { payloadVersion: 1, phase: 'submitted', answers } });
      }
      const idempotencyKey = await submitKey({
        sessionId: latest.session.id,
        questionId,
        answerText: answer,
        processText,
      });
      if (epochRef.current !== submitEpoch) return;
      const data = await apiFetch<AttemptResponse>('/api/maic/runtime/submit', {
        method: 'POST',
        headers: {
          'x-sew-project-id': scope.projectId,
          'x-sew-generation': String(scope.generation),
        },
        body: JSON.stringify({
          scope,
          sessionId: latest.session.id,
          expectedLastSeq: lastSeq,
          sceneId,
          questionId,
          idempotencyKey,
          answerText: answer,
          processText,
        }),
      });
      if (epochRef.current !== submitEpoch) return;
      const payload = isQuizPayload(data.record.payload) ? data.record.payload : undefined;
      updateRuntime({
        session: { ...latest.session, status: 'completed' },
        lastSeq: data.record.seq,
        payload,
      });
      setFeedback(
        `服务端审核已保存（${data.attempt.kind}）。` +
          (data.attempt.masteryAfter ? `掌握状态：${data.attempt.masteryAfter}。` : '未产生掌握状态。') +
          (data.deduplicated ? '重复请求已复用既有收据。' : ''),
      );
    } catch (caught) {
      if (epochRef.current === submitEpoch) setError(describeApiError(caught));
    } finally {
      if (epochRef.current === submitEpoch) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const retry = async (): Promise<void> => {
    const epoch = epochRef.current + 1;
    epochRef.current = epoch;
    const isCurrent = () => epochRef.current === epoch;
    setFeedback(null);
    await openAttempt(true, isCurrent);
  };

  if (!question) return <div className="card" data-scene="quiz">当前测验场景没有题目。</div>;
  if (loading) return <div className="card" data-scene="quiz" role="status">正在读取本人测验运行记录…</div>;

  const completed = runtime?.session.status === 'completed' && runtime.payload?.phase === 'reviewed';
  return (
    <div className="card" data-scene="quiz" data-scene-id={sceneId} data-question-id={dslQuestionId}>
      <h2>测验：{question.question}</h2>
      {reviewedBy ? <p className="muted">来源审核：{reviewedBy}</p> : null}
      {(question.options ?? []).map((option) => (
        <label key={option.value} className="check-list" style={{ display: 'block' }}>
          <input
            type="radio"
            name={`q-${dslQuestionId}`}
            value={option.value}
            data-answer-option={option.value}
            checked={answer === option.value}
            disabled={completed || busy}
            onChange={() => setAnswer(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
      <div className="field">
        <label htmlFor={`process-${dslQuestionId}`}>解题过程</label>
        <textarea
          id={`process-${dslQuestionId}`}
          value={processText}
          disabled={completed || busy}
          onChange={(event) => setProcessText(event.target.value)}
        />
      </div>
      {completed ? (
        <>
          <p className="muted" data-attempt-result>{feedback ?? '已从本地服务读回审核记录。'}</p>
          <button type="button" className="btn" disabled={busy || loading} onClick={() => void retry()}>
            开始一次新的测验
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          data-attempt-submit
          disabled={busy || !runtime || !questionId || !answer}
          onClick={() => void submit()}
        >
          {busy ? '正在由服务核验并保存…' : '提交给服务判分'}
        </button>
      )}
      <p className="muted">草稿会自动保存，提交后可重新打开查看答案与解题过程。演示测验不计入正式掌握状态。</p>
      {error ? <p role="alert" className="error-text">{error}</p> : null}
      {feedback && !completed ? <p className="muted" data-attempt-result>{feedback}</p> : null}
    </div>
  );
}
