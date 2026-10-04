'use client';

import { apiResponses, type AttemptGradingContextDto } from '@sew/study-contracts';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QuizContent, RuntimeSession } from '@openmaic/dsl';
import { HttpRuntimeStore } from '@openmaic/storage/runtime/http';
import { apiFetch, getSessionToken, describeApiError } from '../../lib/client';
import { readMultipleAnswer, writeMultipleAnswer, quizResultFeedback, hasQuizAnswer, selectSceneAttempt } from '../../lib/quiz-answer';

interface Scope {
  projectId: string;
  generation: number;
}

interface QuizPayload {
  payloadVersion: 1;
  phase: 'draft' | 'submitted' | 'reviewed';
  answers: Record<string, unknown>;
  results?: Array<{ questionId: string; correct: boolean | null; status?: string; earned?: number | null }>;
}

interface RuntimeView {
  session: RuntimeSession;
  lastSeq: number | null;
  payload?: QuizPayload;
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
  const questionType = question?.type ?? 'single';
  const allowedOptions = useMemo(() => (question?.options ?? []).map((option) => option.value), [question?.options]);
  const restoreAnswer = useCallback((payload?: QuizPayload): string => {
    const value = payload?.answers[dslQuestionId];
    if (value !== undefined && typeof value !== 'string') throw new Error('本人作答草稿格式损坏，无法恢复；请开始新的测验。');
    const text = typeof value === 'string' ? value : '';
    return questionType === 'multiple' && text ? writeMultipleAnswer(readMultipleAnswer(text, allowedOptions)) : text;
  }, [allowedOptions, dslQuestionId, questionType]);
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
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [gradingContext, setGradingContext] = useState<AttemptGradingContextDto | null>(null);
  const [gradingReadError, setGradingReadError] = useState<string | null>(null);
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
    setAnswer('');
    setRecoveryFailed(false);
    busyRef.current = false;
    setBusy(false);
    setProcessText('');
    setFeedback(null);
    updateRuntime(null);
    lastDraftHashRef.current = null;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    try {
      await appendTailRef.current.catch(() => {});
      if (!isCurrent()) return;
      appendTailRef.current = Promise.resolve();
      const identity = await apiFetch('/api/maic/runtime/learner-key', apiResponses.classroomLearner, {
        headers: {
          'x-sew-project-id': scope.projectId,
          'x-sew-generation': String(scope.generation),
        },
      });
      if (!isCurrent()) return;
      const baseId = `quiz-attempt:${encodeURIComponent(stageId)}:${encodeURIComponent(sceneId)}:${encodeURIComponent(identity.learnerKey)}`;
      const sessions = (await store.listSessions(stageId, identity.learnerKey))
        .filter((session) => session.kind === 'quizAttempt' && session.stageId === stageId)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      if (!isCurrent()) return;
      const candidateRecords = await Promise.all(sessions.map(async (session) => ({
        session,
        records: await store.listRecords(session.id),
      })));
      if (!isCurrent()) return;
      const latest = !startNew ? selectSceneAttempt(candidateRecords, sceneId, baseId) : undefined;
      if (latest && !startNew) {
        const record = latest.records.at(-1);
        const payload = record && isQuizPayload(record.payload) ? record.payload : undefined;
        updateRuntime({ session: latest.session, lastSeq: record?.seq ?? null, payload });
        setAnswer(restoreAnswer(payload));
        setProcessText(typeof payload?.answers[`${dslQuestionId}:process`] === 'string'
          ? payload.answers[`${dslQuestionId}:process`] as string
          : '');
        if (latest.session.status === 'completed' && payload?.phase === 'reviewed') {
          const result = payload.results?.find((item) => item.questionId === dslQuestionId);
          setFeedback(quizResultFeedback(result) + '可关闭并重新打开课堂读回此记录。');
        }
        setLoading(false);
        return;
      }

      const timestampNow = timestamp();
      let created: RuntimeSession | undefined;
      for (let index = 0; index < 64; index += 1) {
        const id = index === 0 ? baseId : `${baseId}:retry:${index}`;
        const existing = await store.getSession(id);
        if (!isCurrent()) return;
        if (existing) {
          if (existing.kind !== 'quizAttempt' || existing.stageId !== stageId || existing.learnerKey !== identity.learnerKey) {
            throw new Error('测验会话归属与当前课堂不一致，不能恢复。');
          }
          if (!startNew && existing.status === 'active') {
            const records = await store.listRecords(id);
            if (!isCurrent()) return;
            if (!selectSceneAttempt([{ session: existing, records }], sceneId, baseId)) continue;
            const record = records.at(-1);
            const payload = record && isQuizPayload(record.payload) ? record.payload : undefined;
            updateRuntime({ session: existing, lastSeq: record?.seq ?? null, payload });
            setAnswer(restoreAnswer(payload));
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
          if (!raced || raced.status !== 'active' || raced.kind !== 'quizAttempt'
            || raced.stageId !== stageId || raced.learnerKey !== identity.learnerKey) throw caught;
          const records = await store.listRecords(id);
          if (!isCurrent()) return;
          if (!selectSceneAttempt([{ session: raced, records }], sceneId, baseId)) throw caught;
          const record = records.at(-1);
          const payload = record && isQuizPayload(record.payload) ? record.payload : undefined;
          updateRuntime({ session: raced, lastSeq: record?.seq ?? null, payload });
          setAnswer(restoreAnswer(payload));
          setProcessText(typeof payload?.answers[`${dslQuestionId}:process`] === 'string'
            ? payload.answers[`${dslQuestionId}:process`] as string : '');
          return;
        }
      }
      if (!created) throw new Error('无法为本次测验创建课堂运行会话，请重试。');
      updateRuntime({ session: created, lastSeq: null });
      setAnswer('');
      setProcessText('');
      setFeedback(null);
    } catch (caught) {
      if (isCurrent()) {
        setRecoveryFailed(true);
        setError(describeApiError(caught));
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [dslQuestionId, restoreAnswer, sceneId, scope.generation, scope.projectId, stageId, store]);

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
  const selectedOptions = useMemo(() => {
    if (questionType !== 'multiple') return [];
    try { return readMultipleAnswer(answer, allowedOptions); } catch { return []; }
  }, [allowedOptions, answer, questionType]);
  const hasAnswer = !recoveryFailed && (questionType === 'multiple' ? selectedOptions.length > 0 : hasQuizAnswer(questionType, answer, allowedOptions));

  // The submission receipt stays immutable. Later human reviews are a separate
  // versioned read model, available only after this personal submission exists.
  const completedSessionId = runtime?.session.status === 'completed' ? runtime.session.id : null;
  useEffect(() => {
    setGradingContext(null);
    setGradingReadError(null);
    if (!completedSessionId || questionType !== 'short_answer' || !questionId) return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const key = await submitKey({ sessionId: completedSessionId, questionId, answerText: answer, processText });
        if (!active) return;
        const query = new URLSearchParams({ idempotencyKey: key, projectId: scope.projectId, generation: String(scope.generation) });
        const context = await apiFetch(`/api/study/grading?${query}`, apiResponses.attemptGradingContext, { signal: controller.signal });
        if (active) setGradingContext(context);
      } catch (caught) {
        if (active) setGradingReadError(describeApiError(caught));
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [answer, completedSessionId, processText, questionId, questionType, scope.generation, scope.projectId]);

  useEffect(() => {
    if (!runtime || runtime.session.status !== 'active' || (runtime.payload && runtime.payload.phase !== 'draft') || loading || busy || recoveryFailed) return;
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
  }, [answers, busy, loading, recoveryFailed, runtime, sceneId, store]);

  const submit = async (): Promise<void> => {
    if (!runtime || !questionId || !dslQuestionId || !hasAnswer || busyRef.current || runtime.session.status !== 'active') return;
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
      const data = await apiFetch('/api/maic/runtime/submit', apiResponses.quizSubmit, {
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
      setFeedback(quizResultFeedback(payload?.results?.find((item) => item.questionId === dslQuestionId))
        + (data.attempt.masteryAfter ? `掌握状态：${data.attempt.masteryAfter}。` : '')
        + (data.deduplicated ? '重复请求已复用既有收据。' : ''));
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

  const completed = runtime?.session.status === 'completed';
  const submitted = completed || runtime?.payload?.phase === 'submitted' || runtime?.payload?.phase === 'reviewed';
  return (
    <div className="card" data-scene="quiz" data-scene-id={sceneId} data-question-id={dslQuestionId}>
      <h2>测验：{question.question}</h2>
      {reviewedBy ? <p className="muted">来源审核：{reviewedBy}</p> : null}
      {questionType === 'short_answer' ? <div className="field">
        <label htmlFor={`answer-${dslQuestionId}`}>本人作答</label>
        <textarea id={`answer-${dslQuestionId}`} data-short-answer value={answer} disabled={submitted || busy || recoveryFailed} onChange={(event) => setAnswer(event.target.value)} />
      </div> : (question.options ?? []).map((option) => (
        <label key={option.value} className="check-list" style={{ display: 'block' }}>
          <input
            type={questionType === 'multiple' ? 'checkbox' : 'radio'}
            name={`q-${dslQuestionId}`}
            value={option.value}
            data-answer-option={option.value}
            checked={questionType === 'multiple' ? selectedOptions.includes(option.value) : answer === option.value}
            disabled={submitted || busy || recoveryFailed}
            onChange={(event) => setAnswer(questionType === 'multiple'
              ? writeMultipleAnswer(event.target.checked ? [...selectedOptions, option.value] : selectedOptions.filter((value) => value !== option.value))
              : option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
      <div className="field">
        <label htmlFor={`process-${dslQuestionId}`}>解题过程</label>
        <textarea
          id={`process-${dslQuestionId}`}
          value={processText}
          disabled={submitted || busy || recoveryFailed}
          onChange={(event) => setProcessText(event.target.value)}
        />
      </div>
      {completed ? (
        <>
          <p className="muted" data-attempt-result>{gradingContext
            ? `${quizResultFeedback(gradingContext.effectiveGrading)}${gradingContext.currentReviewVersion > 0 ? `人工评分 v${gradingContext.currentReviewVersion}。` : ''}`
            : feedback ?? '已从本地服务读回审核记录。'}</p>
          {gradingContext ? <details data-grading-reference>
            <summary>核对参考答案与评分依据</summary>
            <p>参考答案：{gradingContext.referenceAnswer}</p>
            <p>解析：{gradingContext.solution || '未登记解析。'}</p>
            <p>评分标准：{gradingContext.rubric}</p>
            {gradingContext.currentReviewVersion > 0 ? <>
              <p>评分依据：{gradingContext.reviews.at(-1)?.basis}</p>
              <p>不确定性：{gradingContext.reviews.at(-1)?.uncertainty}</p>
            </> : null}
            <a href={`/workbench/mistakes#attempt-${gradingContext.attemptId}`}>前往错题本核对评分</a>
          </details> : null}
          {gradingReadError ? <p role="alert" className="error-text">当前评分历史读取失败：{gradingReadError} 请到错题本重新读取。</p> : null}
          <button type="button" className="btn" disabled={busy || loading} onClick={() => void retry()}>
            开始一次新的测验
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          data-attempt-submit
          disabled={busy || !runtime || !questionId || !hasAnswer}
          onClick={() => void submit()}
        >
          {busy ? '正在由服务核验并保存…' : '提交给服务判分'}
        </button>
      )}
      <p className="muted">草稿会自动保存，提交后可重新打开查看答案与解题过程。正式本人作答按已核验结果更新掌握；简答先待判分，人工核对后保存评分版本，演示测验不计入正式进度。</p>
      {error ? <p role="alert" className="error-text">{error}</p> : null}
      {recoveryFailed ? <button type="button" className="btn" disabled={busy} onClick={() => void retry()}>开始一次新的测验</button> : null}
      {feedback && !completed ? <p className="muted" data-attempt-result>{feedback}</p> : null}
    </div>
  );
}
