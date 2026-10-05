import { describe, expect, it } from 'vitest';
import {
  beginLessonCommandAttempt,
  lessonCommandFailureState,
  planConfirmationKey,
} from '../apps/learning/components/lesson-command-retry';
import { createCommandGate, executeCommand } from '../apps/learning/lib/command-gate';

describe('课件命令的回执恢复与确认绑定', () => {
  it('迟到保存响应隔离，恢复仍使用原意图与nonce', async () => {
    const attempt = beginLessonCommandAttempt(
      { action: 'save-scene-plan', baseRevision: 2, scenes: [{ title: '旧快照' }] },
      'stable-save-request',
    );
    const gate = createCommandGate();
    let resolve!: (result: { revision: number }) => void;
    const writes: number[] = [];
    const bodies: string[] = [];
    const pending = executeCommand(
      gate,
      async () => {
        bodies.push(attempt.body);
        return new Promise<{ revision: number }>((done) => {
          resolve = done;
        });
      },
      {
        onSuccess: (result) => {
          writes.push(result.revision);
        },
      },
    );
    gate.invalidate();
    resolve({ revision: 3 });
    await pending;
    expect(writes).toEqual([]);
    await executeCommand(
      createCommandGate(),
      async () => {
        bodies.push(attempt.body);
        return { revision: 3 };
      },
      {
        onSuccess: (result) => {
          writes.push(result.revision);
        },
      },
    );
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[1]!)).toMatchObject({
      requestId: 'stable-save-request',
      baseRevision: 2,
    });
    expect(writes).toEqual([3]);
  });

  it('传输错误与未知回执保持待核，只有权威失败或取消回执允许新尝试', () => {
    expect(lessonCommandFailureState(new Error('response lost'))).toBe('unknown');
    expect(lessonCommandFailureState({ code: 'API_RESPONSE_INVALID', pending: false })).toBe(
      'unknown',
    );
    expect(
      lessonCommandFailureState({ code: 'VERSION_CONFLICT', details: { receiptState: 'unknown' } }),
    ).toBe('unknown');
    expect(lessonCommandFailureState({ details: { receiptState: 'failed' } })).toBe('failed');
    expect(lessonCommandFailureState({ details: { receiptState: 'cancelled' } })).toBe('failed');
  });

  it('覆盖确认绑定用户看到的revision和digest，两者任一推进后旧确认失效', () => {
    const confirmed = planConfirmationKey(4, 'digest-before');
    expect(confirmed).toBe(planConfirmationKey(4, 'digest-before'));
    expect(confirmed).not.toBe(planConfirmationKey(5, 'digest-before'));
    expect(confirmed).not.toBe(planConfirmationKey(4, 'digest-after'));
    expect(planConfirmationKey(0, null)).not.toBe(planConfirmationKey(1, 'first-plan'));
  });
});
