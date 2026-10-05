'use client';
import { apiResponses, type AttemptGradingContextDto } from '@sew/study-contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QuizContent, RuntimeSession } from '@openmaic/dsl';
import { HttpRuntimeStore } from '@openmaic/storage/runtime/http';
import { apiFetch, getSessionToken, describeApiError } from './client';
import {
  readMultipleAnswer,
  writeMultipleAnswer,
  quizResultFeedback,
  hasQuizAnswer,
  selectSceneAttempt,
} from './quiz-answer';

interface Scope {
  projectId: string;
  generation: number;
}

interface QuizPayload {
  payloadVersion: 1;
  phase: 'draft' | 'submitted' | 'reviewed';
  answers: Record<string, unknown>;
  results?: Array<{
    questionId: string;
    correct: boolean | null;
    status?: string;
    earned?: number | null;
  }>;
}

interface RuntimeView {
  session: RuntimeSession;
  lastSeq: number | null;
  payload?: QuizPayload;
}

const isQuizPayload = (value: unknown): value is QuizPayload => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.payloadVersion === 1 &&
    (payload.phase === 'draft' || payload.phase === 'submitted' || payload.phase === 'reviewed') &&
    typeof payload.answers === 'object' &&
    payload.answers !== null &&
    !Array.isArray(payload.answers)
  );
};

const timestamp = (): string => new Date().toISOString();

const submitKey = async (input: {
  sessionId: string;
  questionId: string;
  answerText: string;
  processText: string;
}): Promise<string> => {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      'sew-quiz-submit-v1',
      input.sessionId,
      input.questionId,
      input.answerText,
      input.processText,
    ]),
  );
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `quiz-v1-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

/** Quiz drafts, ordered appends and durable submissions retain the upstream RuntimeStore contract. */
export const useQuizAttemptSession = ({
  content,
  sceneId,
  stageId,
  scope,
  questionId,
}: {
  content: QuizContent;
  sceneId: string;
  stageId: string;
  scope: Scope;
  questionId?: string;
}) => {
  const question = content.questions[0];
  const dslQuestionId = question?.id ?? '';
  const questionType = question?.type ?? 'single';
  const allowedOptions = useMemo(
    () => (question?.options ?? []).map((option) => option.value),
    [question?.options],
  );
  const restoreAnswer = useCallback(
    (payload?: QuizPayload): string => {
      const value = payload?.answers[dslQuestionId];
      if (value !== undefined && typeof value !== 'string')
        throw new Error('本人作答草稿格式损坏，无法恢复；请开始新的测验。');
      const text = typeof value === 'string' ? value : '';
      return questionType === 'multiple' && text
        ? writeMultipleAnswer(readMultipleAnswer(text, allowedOptions))
        : text;
    },
    [allowedOptions, dslQuestionId, questionType],
  );
  const store = useMemo(
    () =>
      new HttpRuntimeStore({
        baseUrl: '/api/maic',
        headers: () => {
          const token = getSessionToken();
          return {
            ...(token ? { 'x-sew-session': token } : {}),
            'x-sew-project-id': scope.projectId,
            'x-sew-generation': String(scope.generation),
          };
        },
      }),
    [scope.generation, scope.projectId],
  );
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

  const restoreAttempt = useCallback(
    (next: RuntimeView): void => {
      updateRuntime(next);
      setAnswer(restoreAnswer(next.payload));
      const process = next.payload?.answers[dslQuestionId + ':process'];
      setProcessText(typeof process === 'string' ? process : '');
      setFeedback(
        next.session.status === 'completed' && next.payload?.phase === 'reviewed'
          ? quizResultFeedback(
              next.payload.results?.find((item) => item.questionId === dslQuestionId),
            ) + '可关闭并重新打开课堂读回此记录。'
          : null,
      );
    },
    [dslQuestionId, restoreAnswer],
  );

  const openAttempt = useCallback(
    async (startNew: boolean, isCurrent: () => boolean): Promise<void> => {
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
        const identity = await apiFetch(
          '/api/maic/runtime/learner-key',
          apiResponses.classroomLearner,
          {
            headers: {
              'x-sew-project-id': scope.projectId,
              'x-sew-generation': String(scope.generation),
            },
          },
        );
        if (!isCurrent()) return;
        const baseId = `quiz-attempt:${encodeURIComponent(stageId)}:${encodeURIComponent(sceneId)}:${encodeURIComponent(identity.learnerKey)}`;
        const sessions = (await store.listSessions(stageId, identity.learnerKey))
          .filter((session) => session.kind === 'quizAttempt' && session.stageId === stageId)
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
        if (!isCurrent()) return;
        const candidateRecords = await Promise.all(
          sessions.map(async (session) => ({
            session,
            records: await store.listRecords(session.id),
          })),
        );
        if (!isCurrent()) return;
        const latest = !startNew
          ? selectSceneAttempt(candidateRecords, sceneId, baseId)
          : undefined;
        if (latest && !startNew) {
          const record = latest.records.at(-1);
          const payload = record && isQuizPayload(record.payload) ? record.payload : undefined;
          restoreAttempt({ session: latest.session, lastSeq: record?.seq ?? null, payload });
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
            if (
              existing.kind !== 'quizAttempt' ||
              existing.stageId !== stageId ||
              existing.learnerKey !== identity.learnerKey
            ) {
              throw new Error('测验会话归属与当前课堂不一致，不能恢复。');
            }
            if (!startNew && existing.status === 'active') {
              const records = await store.listRecords(id);
              if (!isCurrent()) return;
              if (!selectSceneAttempt([{ session: existing, records }], sceneId, baseId)) continue;
              const record = records.at(-1);
              const payload = record && isQuizPayload(record.payload) ? record.payload : undefined;
              restoreAttempt({ session: existing, lastSeq: record?.seq ?? null, payload });
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
            if (
              !raced ||
              raced.status !== 'active' ||
              raced.kind !== 'quizAttempt' ||
              raced.stageId !== stageId ||
              raced.learnerKey !== identity.learnerKey
            )
              throw caught;
            const records = await store.listRecords(id);
            if (!isCurrent()) return;
            if (!selectSceneAttempt([{ session: raced, records }], sceneId, baseId)) throw caught;
            const record = records.at(-1);
            const payload = record && isQuizPayload(record.payload) ? record.payload : undefined;
            restoreAttempt({ session: raced, lastSeq: record?.seq ?? null, payload });
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
    },
    [restoreAttempt, sceneId, scope.generation, scope.projectId, stageId, store],
  );

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

  const answers = useMemo(
    () => ({
      [dslQuestionId]: answer,
      [`${dslQuestionId}:process`]: processText,
    }),
    [answer, dslQuestionId, processText],
  );
  const selectedOptions = useMemo(() => {
    if (questionType !== 'multiple') return [];
    try {
      return readMultipleAnswer(answer, allowedOptions);
    } catch {
      return [];
    }
  }, [allowedOptions, answer, questionType]);
  const hasAnswer =
    !recoveryFailed &&
    (questionType === 'multiple'
      ? selectedOptions.length > 0
      : hasQuizAnswer(questionType, answer, allowedOptions));

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
        const key = await submitKey({
          sessionId: completedSessionId,
          questionId,
          answerText: answer,
          processText,
        });
        if (!active) return;
        const query = new URLSearchParams({
          idempotencyKey: key,
          projectId: scope.projectId,
          generation: String(scope.generation),
        });
        const context = await apiFetch(
          `/api/study/grading?${query}`,
          apiResponses.attemptGradingContext,
          { signal: controller.signal },
        );
        if (active) setGradingContext(context);
      } catch (caught) {
        if (active) setGradingReadError(describeApiError(caught));
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    answer,
    completedSessionId,
    processText,
    questionId,
    questionType,
    scope.generation,
    scope.projectId,
  ]);

  useEffect(() => {
    if (
      !runtime ||
      runtime.session.status !== 'active' ||
      (runtime.payload && runtime.payload.phase !== 'draft') ||
      loading ||
      busy ||
      recoveryFailed
    )
      return;
    const draftHash = JSON.stringify([runtime.session.id, sceneId, answers]);
    if (lastDraftHashRef.current === draftHash) return;
    const writerEpoch = epochRef.current;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      const write = appendTailRef.current
        .catch(() => {})
        .then(async () => {
          const latest = runtimeRef.current;
          if (epochRef.current !== writerEpoch || busyRef.current) return;
          if (!latest || latest.session.status !== 'active') return;
          const record = await store.appendRecord(
            {
              id: crypto.randomUUID(),
              sessionId: latest.session.id,
              sceneId,
              createdAt: timestamp(),
              payload: { payloadVersion: 1, phase: 'draft', answers },
            },
            { expectedLastSeq: latest.lastSeq },
          );
          if (epochRef.current !== writerEpoch) return;
          if (runtimeRef.current?.session.id !== latest.session.id) return;
          lastDraftHashRef.current = draftHash;
          updateRuntime({
            ...latest,
            lastSeq: record.seq,
            payload: { payloadVersion: 1, phase: 'draft', answers },
          });
        });
      appendTailRef.current = write;
      void write.catch((caught: unknown) => {
        if (epochRef.current === writerEpoch) setError(describeApiError(caught));
      });
    }, 350);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [answers, busy, loading, recoveryFailed, runtime, sceneId, store]);

  const submit = async (): Promise<void> => {
    if (
      !runtime ||
      !questionId ||
      !dslQuestionId ||
      !hasAnswer ||
      busyRef.current ||
      runtime.session.status !== 'active'
    )
      return;
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
      if (!latest || latest.session.id !== runtime.session.id)
        throw new Error('课堂测验会话已切换，请重新读取后提交。');
      let lastSeq = latest.lastSeq;
      if (latest.payload?.phase !== 'submitted') {
        const submitted = await store.appendRecord(
          {
            id: crypto.randomUUID(),
            sessionId: latest.session.id,
            sceneId,
            createdAt: timestamp(),
            payload: { payloadVersion: 1, phase: 'submitted', answers },
          },
          { expectedLastSeq: lastSeq },
        );
        if (epochRef.current !== submitEpoch) return;
        lastSeq = submitted.seq;
        updateRuntime({
          ...latest,
          lastSeq,
          payload: { payloadVersion: 1, phase: 'submitted', answers },
        });
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
      setFeedback(
        quizResultFeedback(payload?.results?.find((item) => item.questionId === dslQuestionId)) +
          (data.attempt.masteryAfter ? `掌握状态：${data.attempt.masteryAfter}。` : '') +
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

  return {
    question,
    dslQuestionId,
    questionType,
    runtime,
    answer,
    setAnswer,
    processText,
    setProcessText,
    loading,
    recoveryFailed,
    busy,
    error,
    feedback,
    gradingContext,
    gradingReadError,
    selectedOptions,
    hasAnswer,
    submit,
    retry,
  };
};
