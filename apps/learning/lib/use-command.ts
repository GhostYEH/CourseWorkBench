'use client';

import { useCallback, useLayoutEffect, useMemo, useState, type SetStateAction } from 'react';
import { describeApiError } from './client';
import {
  createCommandGate,
  executeCommand,
  type CommandContext,
  type CommandHandlers,
} from './command-gate';

/** Request IDs and receipt acknowledgement stay with the operation's domain protocol. */
export const useCommand = (scopeKey: string, initialError: string | null = null) => {
  const owner = useMemo(() => ({ key: scopeKey, gate: createCommandGate() }), [scopeKey]);
  const [state, setState] = useState({ owner, busy: false, error: initialError });
  useLayoutEffect(() => {
    owner.gate.activate();
    return () => owner.gate.invalidate();
  }, [owner]);
  const setError = useCallback(
    (value: SetStateAction<string | null>) => {
      setState((current) => ({
        owner,
        busy: current.owner === owner && current.busy,
        error:
          typeof value === 'function'
            ? value(current.owner === owner ? current.error : null)
            : value,
      }));
    },
    [owner],
  );
  const run = useCallback(
    <T>(
      operation: (context: CommandContext) => Promise<T>,
      handlers: CommandHandlers<T> = {},
    ): Promise<T | undefined> =>
      executeCommand(owner.gate, operation, {
        ...handlers,
        onStart: () => {
          setState({ owner, busy: true, error: null });
          handlers.onStart?.();
        },
        onError: handlers.onError ?? ((caught) => setError(describeApiError(caught))),
        onFinish: () => {
          try {
            handlers.onFinish?.();
          } finally {
            setState((current) =>
              current.owner === owner ? { ...current, busy: false } : current,
            );
          }
        },
      }),
    [owner, setError],
  );
  return {
    busy: state.owner === owner && state.busy,
    error: state.owner === owner ? state.error : initialError,
    setError,
    run,
    cancel: owner.gate.cancel,
  };
};
