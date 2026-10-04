import { describe, expect, it } from 'vitest';
import { createCommandGate } from '../apps/learning/lib/command-gate';

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
    gate.invalidate(); gate.activate();
    const current = gate.begin()!;
    let value = 'initial';
    old.commit(() => { value = 'stale'; });
    old.finish();
    expect(value).toBe('initial');
    expect(gate.begin()).toBeNull();
    current.commit(() => { value = 'current'; });
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
});
