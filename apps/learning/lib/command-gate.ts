export interface CommandContext {
  signal: AbortSignal;
  isCurrent: () => boolean;
  isActive: () => boolean;
  commit: (apply: () => void) => void;
}

/** One in-flight command per view; invalidation revokes results even if fetch ignores abort. */
export const createCommandGate = () => {
  let revision = 0;
  let active = true;
  let pending: AbortController | null = null;
  return {
    /** Whether this gate still owns the view; a revoked scope may not write view state. */
    isLive: () => active,
    activate() {
      active = true;
    },
    invalidate() {
      active = false;
      revision += 1;
      pending?.abort();
      pending = null;
    },
    cancel() {
      pending?.abort();
    },
    begin(): (CommandContext & { finish: () => void }) | null {
      if (!active || pending) return null;
      const controller = new AbortController();
      const started = revision;
      pending = controller;
      const isActive = () => active && revision === started && pending === controller;
      const isCurrent = () => isActive() && !controller.signal.aborted;
      return {
        signal: controller.signal,
        isActive,
        isCurrent,
        commit: (apply) => {
          if (isCurrent()) apply();
        },
        finish: () => {
          if (isActive()) pending = null;
        },
      };
    },
  };
};

export interface CommandHandlers<T> {
  onStart?: () => void;
  onSuccess?: (result: T, context: CommandContext) => void | Promise<void>;
  onError?: (error: unknown, context: CommandContext) => void;
  onCancel?: () => void;
  /** The scope was revoked while this command was in flight, so its result was isolated. */
  onStale?: () => void;
  onFinish?: () => void;
}

/** Every outcome, including a failed callback, releases only its own command. */
export const executeCommand = async <T>(
  gate: ReturnType<typeof createCommandGate>,
  operation: (context: CommandContext) => Promise<T>,
  handlers: CommandHandlers<T> = {},
): Promise<T | undefined> => {
  const command = gate.begin();
  if (!command) return undefined;
  let revoked = false;
  try {
    handlers.onStart?.();
    const result = await operation(command);
    if (!command.isCurrent()) {
      revoked = !command.isActive();
      return undefined;
    }
    await handlers.onSuccess?.(result, command);
    if (!command.isCurrent()) {
      revoked = !command.isActive();
      return undefined;
    }
    return result;
  } catch (error) {
    if (!command.isActive()) {
      revoked = true;
      return undefined;
    }
    if (command.signal.aborted) handlers.onCancel?.();
    else if (handlers.onError) handlers.onError(error, command);
    else throw error;
    return undefined;
  } finally {
    if (command.isActive()) {
      try {
        handlers.onFinish?.();
      } finally {
        command.finish();
      }
    }
    if (revoked) handlers.onStale?.();
  }
};
