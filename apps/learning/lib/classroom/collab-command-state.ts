/**
 * 保存未确认协作命令的完整请求，使丢失响应后的重试仍对应同一笔业务。
 *
 * 调用方在会话/项目/房间 scope 改变时重建 tracker；网络错误不清除 pending。
 * 只有成功响应才 confirm，服务端确定拒绝时才可显式 discard。
 */

export type CollabCommandIdKind = 'request' | 'room' | 'event';
export type CollabCommandPayload = Readonly<Record<string, unknown> & { requestId: string }>;

export interface CollabCommandTrackerOptions {
  idFactory?: (kind: CollabCommandIdKind) => string;
  persistence?: CollabCommandPersistence;
  validatePayload?: (value: unknown) => value is CollabCommandPayload;
}

export interface CollabCommandPersistence {
  readonly projectId: string;
  readonly uid: string;
  readonly storageKey: string;
  readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

export interface CollabCommandPrepareOptions {
  /** 事件首次提交时看到的权威尾序号；未确认重试不会重新取该值。 */
  tailSeq?: number;
}

export interface CollabCommandTracker {
  readonly persistenceAvailable: boolean;
  prepare(
    path: string,
    intent: Record<string, unknown>,
    options?: CollabCommandPrepareOptions,
  ): CollabCommandPayload;
  confirm(path: string, originalPayload: CollabCommandPayload): boolean;
  discard(path: string, originalPayload: CollabCommandPayload): boolean;
}

const defaultIdFactory = (kind: CollabCommandIdKind): string => `${kind}_${crypto.randomUUID()}`;

/** 隔离调用方的可变输入；键顺序不会改变命令意图。 */
const jsonSnapshot = (value: Record<string, unknown>): Record<string, unknown> =>
  structuredClone(value);

const stableJson = (value: unknown): string => {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, sorted(entry)]),
      );
    }
    return item;
  };
  return JSON.stringify(sorted(value));
};

const freezeSnapshot = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freezeSnapshot(entry);
    Object.freeze(value);
  }
  return value;
};

const isInvitation = (path: string, intent: Record<string, unknown>): boolean =>
  intent['action'] === 'invite' &&
  (path.endsWith('/invitations') || path.endsWith('/collab/online'));

/**
 * 事件类命令：本机链路的 `/events` 与在线链路的 `scene` 动作都携带 `eventId`/`expectedSeq`。
 * 两者用同一套「首次提交取权威尾序号、未确认重试复用原值」的语义。
 */
const isScene = (path: string, intent: Record<string, unknown>): boolean =>
  path.endsWith('/events') || (path.endsWith('/collab/online') && intent['action'] === 'scene');

const logicalIntent = (path: string, input: Record<string, unknown>): Record<string, unknown> => {
  const intent = jsonSnapshot(input);
  delete intent['requestId'];
  if (isInvitation(path, intent)) delete intent['roomId'];
  if (isScene(path, intent)) {
    delete intent['eventId'];
    delete intent['expectedSeq'];
  }
  return intent;
};

const ONLINE_PATH = '/api/study/collab/online';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const createCollabCommandTracker = (
  options: CollabCommandTrackerOptions = {},
): CollabCommandTracker => {
  const idFactory = options.idFactory ?? defaultIdFactory;
  const pending = new Map<string, CollabCommandPayload>();
  let persistenceAvailable = options.persistence !== undefined;
  const keyOf = (path: string, intent: Record<string, unknown>): string =>
    stableJson([path, logicalIntent(path, intent)]);

  const persist = (): void => {
    const persistence = options.persistence;
    if (!persistence || !persistenceAvailable) return;
    try {
      persistence.storage.setItem(
        persistence.storageKey,
        JSON.stringify({
          version: 1,
          projectId: persistence.projectId,
          uid: persistence.uid,
          commands: [...pending.entries()].map(([key, payload]) => ({
            key,
            path: ONLINE_PATH,
            payload,
          })),
        }),
      );
    } catch {
      persistenceAvailable = false;
    }
  };

  const restore = (): void => {
    const persistence = options.persistence;
    const validatePayload = options.validatePayload;
    if (!persistence || !validatePayload) {
      persistenceAvailable = false;
      return;
    }
    try {
      const raw = persistence.storage.getItem(persistence.storageKey);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (
        !isRecord(parsed) ||
        Object.keys(parsed).sort().join(',') !== 'commands,projectId,uid,version' ||
        parsed['version'] !== 1 ||
        parsed['projectId'] !== persistence.projectId ||
        parsed['uid'] !== persistence.uid ||
        !Array.isArray(parsed['commands'])
      ) {
        throw new TypeError('Stored collab command envelope is invalid');
      }
      const restored: Array<[string, CollabCommandPayload]> = [];
      for (const entry of parsed['commands']) {
        if (!isRecord(entry)) {
          throw new TypeError('Stored collab command entry is invalid');
        }
        if (Object.keys(entry).sort().join(',') !== 'key,path,payload') {
          throw new TypeError('Stored collab command entry shape is invalid');
        }
        if (
          entry['path'] !== ONLINE_PATH ||
          typeof entry['key'] !== 'string' ||
          !validatePayload(entry['payload'])
        ) {
          throw new TypeError('Stored collab command payload is invalid');
        }
        const payload = freezeSnapshot(structuredClone(entry['payload']));
        const key = keyOf(ONLINE_PATH, payload);
        if (key !== entry['key'] || restored.some(([existing]) => existing === key)) {
          throw new TypeError('Stored collab command identity is invalid');
        }
        restored.push([key, payload]);
      }
      for (const [key, payload] of restored) pending.set(key, payload);
    } catch {
      pending.clear();
      try {
        persistence.storage.removeItem(persistence.storageKey);
      } catch {
        persistenceAvailable = false;
      }
    }
  };
  restore();

  const removeConfirmed = (path: string, originalPayload: CollabCommandPayload): boolean => {
    const key = keyOf(path, originalPayload);
    const current = pending.get(key);
    // 对比完整请求：迟到的旧确认不能清掉同正文的下一笔请求。
    if (!current || stableJson(current) !== stableJson(jsonSnapshot(originalPayload))) return false;
    pending.delete(key);
    persist();
    return true;
  };

  return {
    get persistenceAvailable() {
      return persistenceAvailable;
    },
    prepare(path, input, prepareOptions = {}) {
      if (options.persistence && path !== ONLINE_PATH) {
        throw new TypeError('持久化 tracker 仅接受在线协作命令');
      }
      const intent = logicalIntent(path, input);
      const key = keyOf(path, intent);
      const prior = pending.get(key);
      if (prior) return prior;

      const generated: Record<string, unknown> = {};
      if (isInvitation(path, intent)) generated['roomId'] = idFactory('room');
      if (isScene(path, intent)) {
        const tailSeq = prepareOptions.tailSeq;
        if (
          !Number.isSafeInteger(tailSeq) ||
          tailSeq === undefined ||
          tailSeq < 0 ||
          tailSeq >= Number.MAX_SAFE_INTEGER
        ) {
          throw new RangeError('事件首次提交需要有效的 tailSeq');
        }
        generated['eventId'] = idFactory('event');
        generated['expectedSeq'] = tailSeq + 1;
      }
      const payload = freezeSnapshot({ ...intent, ...generated, requestId: idFactory('request') });
      if (options.persistence && (!options.validatePayload || !options.validatePayload(payload))) {
        throw new TypeError('协作命令不符合持久化合同');
      }
      pending.set(key, payload);
      persist();
      return payload;
    },
    confirm: removeConfirmed,
    discard: removeConfirmed,
  };
};
