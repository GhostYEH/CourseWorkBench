import { describe, expect, it, vi } from 'vitest';
import { createCommandGate, executeCommand } from '../apps/learning/lib/command-gate';

describe('client command lifecycle', () => {
  it('blocks double submission and releases the lock after settlement', () => {
    const gate = createCommandGate();
    const first = gate.begin()!;
    expect(gate.begin()).toBeNull();
    first.finish();
    expect(gate.begin()).not.toBeNull();
  });
  it('prevents old results from committing after project changes and StrictMode remounts', () => {
    const gate = createCommandGate();
    const old = gate.begin()!;
    gate.invalidate();
    gate.activate();
    const current = gate.begin()!;
    let value = 'initial';
    old.commit(() => {
      value = 'stale';
    });
    old.finish();
    expect(value).toBe('initial');
    expect(gate.begin()).toBeNull();
    current.commit(() => {
      value = 'current';
    });
    expect(value).toBe('current');
  });
  it('aborts the caller without declaring that the server write was rolled back', () => {
    const gate = createCommandGate();
    const command = gate.begin()!;
    gate.cancel();
    expect(command.signal.aborted).toBe(true);
    expect(command.isActive()).toBe(true);
    expect(command.isCurrent()).toBe(false);
    expect(gate.begin()).toBeNull();
    command.finish();
    expect(gate.begin()).not.toBeNull();
  });
  it('releases the command when finishing or error callbacks throw', async () => {
    const gate = createCommandGate();
    await expect(
      executeCommand(gate, async () => 'saved', {
        onFinish: () => {
          throw new Error('finish failed');
        },
      }),
    ).rejects.toThrow('finish failed');
    await expect(
      executeCommand(
        gate,
        async () => {
          throw new Error('request failed');
        },
        {
          onError: () => {
            throw new Error('error callback failed');
          },
        },
      ),
    ).rejects.toThrow('error callback failed');
    expect(await executeCommand(gate, async () => 'next')).toBe('next');
  });
  it('reports once that a revoked scope isolated the result', async () => {
    const gate = createCommandGate();
    let resolve!: (value: string) => void;
    const applied: string[] = [];
    const stale = vi.fn();
    const command = executeCommand(
      gate,
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
      {
        onSuccess: () => {
          applied.push('success');
        },
        onFinish: () => {
          applied.push('finish');
        },
        onStale: stale,
      },
    );
    gate.invalidate();
    resolve('late result');
    expect(await command).toBeUndefined();
    expect(applied).toEqual([]);
    expect(stale).toHaveBeenCalledTimes(1);
  });

  it('does not report staleness for a settled command, a handled failure or a live cancel', async () => {
    const gate = createCommandGate();
    const stale = vi.fn();
    expect(await executeCommand(gate, async () => 'saved', { onStale: stale })).toBe('saved');
    expect(
      await executeCommand(
        gate,
        async () => {
          throw new Error('request failed');
        },
        { onStale: stale, onError: () => undefined },
      ),
    ).toBeUndefined();
    expect(stale).not.toHaveBeenCalled();

    const cancelling = createCommandGate();
    const onCancel = vi.fn();
    const onStaleWhileLive = vi.fn();
    const aborted = executeCommand(
      cancelling,
      (context) =>
        new Promise<string>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { onCancel, onStale: onStaleWhileLive },
    );
    cancelling.cancel();
    expect(await aborted).toBeUndefined();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onStaleWhileLive).not.toHaveBeenCalled();
  });

  it('does not apply a late failure or finish an old command after invalidation', async () => {
    const gate = createCommandGate();
    let fail!: (error: Error) => void;
    let staleCallbacks = 0;
    const old = executeCommand(
      gate,
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
      {
        onError: () => {
          staleCallbacks++;
        },
        onFinish: () => {
          staleCallbacks++;
        },
      },
    );
    gate.invalidate();
    gate.activate();
    const current = gate.begin()!;
    fail(new Error('late request failure'));
    expect(await old).toBeUndefined();
    expect(staleCallbacks).toBe(0);
    expect(current.isCurrent()).toBe(true);
    expect(gate.begin()).toBeNull();
    current.finish();
  });
});
