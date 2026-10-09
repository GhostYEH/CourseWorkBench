import { describe, expect, it } from 'vitest';
import { createDirectorResponseGate } from '../apps/learning/lib/director-response-gate';

describe('Director view response ordering', () => {
  it('keeps a completed stop when a mid-stop GET returns its earlier ready snapshot', async () => {
    const gate = createDirectorResponseGate();
    let view = 'ready';
    const stop = gate.beginCommand();
    const read = gate.beginRead();
    let finishRead!: () => void;
    const delayed = new Promise<void>((resolve) => {
      finishRead = resolve;
    }).then(() => {
      if (gate.acceptsRead(read)) view = 'ready';
    });
    if (gate.commitCommand(stop)) view = 'stopped';
    finishRead();
    await delayed;
    expect(view).toBe('stopped');
    expect(gate.acceptsRead(gate.beginRead())).toBe(true);
  });

  it('discards earlier pause responses and out-of-order refreshes', () => {
    const gate = createDirectorResponseGate();
    const initial = gate.beginRead();
    const pause = gate.beginCommand();
    const stop = gate.beginCommand();
    expect(gate.acceptsRead(initial)).toBe(false);
    expect(gate.commitCommand(stop)).toBe(true);
    expect(gate.commitCommand(pause)).toBe(false);
    const first = gate.beginRead(),
      latest = gate.beginRead();
    expect(gate.acceptsRead(first)).toBe(false);
    expect(gate.acceptsRead(latest)).toBe(true);
  });
});
