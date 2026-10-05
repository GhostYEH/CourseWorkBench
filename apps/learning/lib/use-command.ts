'use client';

import { useCallback, useLayoutEffect, useMemo, useState, type SetStateAction } from 'react';
import { describeApiError } from './client';
import {
  createCommandGate,
  executeCommand,
  type CommandContext,
  type CommandHandlers,
} from './command-gate';

type Scope = { key: string; gate: ReturnType<typeof createCommandGate> };
type VisibleState = { busy: boolean; error: string | null };

/** Request IDs and receipt acknowledgement stay with the operation's domain protocol. */
export const useCommand = (scopeKey: string, initialError: string | null = null) => {
  const owner = useMemo<Scope>(() => ({ key: scopeKey, gate: createCommandGate() }), [scopeKey]);
  const [state, setState] = useState<VisibleState & { owner: Scope }>({
    owner,
    busy: false,
    error: initialError,
  });
  useLayoutEffect(() => {
    owner.gate.activate();
    return () => owner.gate.invalidate();
  }, [owner]);
  /**
   * Late writes are the ones that need guarding: a callback that survived its own scope change
   * must neither clear the new scope's busy flag nor replace the error it wrote. A scope that is
   * still live may always take over state left behind by a revoked one.
   */
  const write = useCallback(
    (mutate: (current: VisibleState) => VisibleState) => {
      if (!owner.gate.isLive()) return;
      setState((current) => {
        if (current.owner !== owner && current.owner.gate.isLive()) return current;
        const visible =
          current.owner === owner
            ? { busy: current.busy, error: current.error }
            : { busy: false, error: null };
        return { owner, ...mutate(visible) };
      });
    },
    [owner],
  );
  const setError = useCallback(
    (value: SetStateAction<string | null>) =>
      write((current) => ({
        busy: current.busy,
        error: typeof value === 'function' ? value(current.error) : value,
      })),
    [write],
  );
  const run = useCallback(
    <T>(
      operation: (context: CommandContext) => Promise<T>,
      handlers: CommandHandlers<T> = {},
    ): Promise<T | undefined> =>
      executeCommand(owner.gate, operation, {
        ...handlers,
        onStart: () => {
          // begin() 只放行「本作用域存活且没有在途命令」的那一次，所以启动一律由它取得可见状态；
          // 若这里允许被丢弃，就会出现「按钮可用但点击毫无反应」。
          setState({ owner, busy: true, error: null });
          handlers.onStart?.();
        },
        onError: handlers.onError ?? ((caught) => setError(describeApiError(caught))),
        onFinish: () => {
          try {
            handlers.onFinish?.();
          } finally {
            write((current) => ({ ...current, busy: false }));
          }
        },
      }),
    [owner, write, setError],
  );
  return {
    busy: state.owner === owner && state.busy,
    error: state.owner === owner ? state.error : initialError,
    setError,
    run,
    cancel: owner.gate.cancel,
  };
};
