'use client';

import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { describeApiError } from './client';
import { createCommandGate, type CommandContext } from './command-gate';

interface CommandHandlers<T> {
  onStart?: () => void;
  onSuccess?: (result: T, context: CommandContext) => void | Promise<void>;
  onError?: (error: unknown, context: CommandContext) => void;
  onCancel?: () => void;
  onFinish?: () => void;
}

/** Request IDs and receipt acknowledgement stay with the operation's domain protocol. */
export const useCommand = (scopeKey: string) => {
  const gate = useMemo(() => createCommandGate(), [scopeKey]);
  const [state, setState] = useState({ gate, busy: false });
  const [error, setError] = useState<string | null>(null);
  useLayoutEffect(() => {
    gate.activate();
    return () => gate.invalidate();
  }, [gate]);
  const run = useCallback(async <T,>(
    operation: (context: CommandContext) => Promise<T>,
    handlers: CommandHandlers<T> = {},
  ): Promise<T | undefined> => {
    const command = gate.begin();
    if (!command) return undefined;
    setState({ gate, busy: true });
    setError(null);
    try {
      handlers.onStart?.();
      const result = await operation(command);
      if (!command.isCurrent()) return undefined;
      await handlers.onSuccess?.(result, command);
      return command.isCurrent() ? result : undefined;
    } catch (caught) {
      if (!command.isActive()) return undefined;
      if (command.signal.aborted) handlers.onCancel?.();
      else if (handlers.onError) handlers.onError(caught, command);
      else setError(describeApiError(caught));
      return undefined;
    } finally {
      if (command.isActive()) {
        handlers.onFinish?.();
        setState({ gate, busy: false });
        command.finish();
      }
    }
  }, [gate]);
  return { busy: state.gate === gate && state.busy, error, setError, run, cancel: gate.cancel };
};
