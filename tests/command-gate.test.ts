import { describe, expect, it } from 'vitest';
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
