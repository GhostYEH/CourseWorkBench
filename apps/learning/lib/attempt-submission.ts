/**
 * 作答幂等状态优先保存在当前标签页的 sessionStorage；不可用时退回页面内存，
 * 不保存会话凭据或答案明文。成功后清除状态，用户再次提交相同内容会获得新的 nonce。
 */
export interface AttemptSubmissionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AttemptSubmissionInput {
  lessonId: string;
  projectId: string;
  generation: number;
  questionId: string;
  actorType: string;
  kind: string;
  answerText: string;
  processText: string;
}

const digest = async (value: string): Promise<string> => {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const namespaceKey = (input: AttemptSubmissionInput): string =>
  `sew:attempt-pending:${input.projectId}:${input.generation}:${input.lessonId}:${input.questionId}`;

const submissionFingerprint = (input: AttemptSubmissionInput): Promise<string> =>
  digest(JSON.stringify([
    input.lessonId,
    input.projectId,
    input.generation,
    input.questionId,
    input.actorType,
    input.kind,
    input.answerText,
    input.processText,
  ]));

const getStorageSafely = (provided?: AttemptSubmissionStorage): AttemptSubmissionStorage | null => {
  if (provided) return provided;
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
};

// sessionStorage 被浏览器策略禁用时，至少让当前页面内的重试沿用相同 nonce。
// 该 Map 不跨页面重载；跨重载恢复仅在 sessionStorage 可用时成立。
const inMemoryPending = new Map<string, { fingerprint: string; nonce: string }>();

/** 为当前未确认提交返回同一个键；内容变更时自动建立新的待提交 nonce。 */
export const getAttemptIdempotencyKey = async (
  input: AttemptSubmissionInput,
  storage?: AttemptSubmissionStorage,
): Promise<string> => {
  const key = namespaceKey(input);
  const fingerprint = await submissionFingerprint(input);
  const resolvedStorage = getStorageSafely(storage);
  let pending = inMemoryPending.get(key) ?? null;
  if (!pending || pending.fingerprint !== fingerprint) {
    try {
      const saved = resolvedStorage?.getItem(key);
      pending = saved ? (JSON.parse(saved) as { fingerprint: string; nonce: string }) : null;
    } catch {
      pending = null;
    }
  }

  if (!pending || pending.fingerprint !== fingerprint || typeof pending.nonce !== 'string') {
    pending = { fingerprint, nonce: globalThis.crypto.randomUUID() };
  }
  inMemoryPending.set(key, pending);
  try {
    resolvedStorage?.setItem(key, JSON.stringify(pending));
  } catch {
    // 当前页面重试由上面的内存副本维持同一 nonce。
  }
  return `attempt-v1-${await digest(JSON.stringify([fingerprint, pending.nonce]))}`;
};

/** 只在成功响应后清理仍对应此请求的待提交状态。 */
export const clearAttemptIdempotencyKey = async (
  input: AttemptSubmissionInput,
  idempotencyKey: string,
  storage?: AttemptSubmissionStorage,
): Promise<void> => {
  const key = namespaceKey(input);
  const fingerprint = await submissionFingerprint(input);
  const resolvedStorage = getStorageSafely(storage);
  const pendingInMemory = inMemoryPending.get(key);
  if (pendingInMemory?.fingerprint === fingerprint) {
    const memoryKey = `attempt-v1-${await digest(JSON.stringify([fingerprint, pendingInMemory.nonce]))}`;
    if (memoryKey === idempotencyKey) inMemoryPending.delete(key);
  }
  try {
    const saved = resolvedStorage?.getItem(key);
    const pending = saved ? (JSON.parse(saved) as { fingerprint: string; nonce: string }) : null;
    if (!pending || pending.fingerprint !== fingerprint) return;
    const expectedKey = `attempt-v1-${await digest(JSON.stringify([pending.fingerprint, pending.nonce]))}`;
    if (expectedKey === idempotencyKey) resolvedStorage?.removeItem(key);
  } catch {
    // Map 已清理；sessionStorage 仍不可用时，后续重试无法跨重载恢复。
  }
};
