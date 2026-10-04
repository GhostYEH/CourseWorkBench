import { describe, expect, it } from 'vitest';
import { createGradingRequestIds } from '../apps/learning/lib/grading-request-ids';

describe('grading command retry intent', () => {
  it('keeps a nonce through a lost response and separates scope, version and edited reviews', () => {
    let next = 0;
    const ids = createGradingRequestIds(() => `request-${++next}`);
    const generate = ['project', 1, 'attempt', 0, 'generate'];
    const original = ids.forIntent(generate);
    expect(ids.forIntent([...generate])).toBe(original);
    expect(ids.forIntent(['project', 2, 'attempt', 0, 'generate'])).not.toBe(original);
    expect(ids.forIntent(['project', 1, 'attempt', 1, 'generate'])).not.toBe(original);
    const review = ['project', 1, 'attempt', 0, 'review', 2, '依据', '疑点', null];
    expect(ids.forIntent(review)).toBe(ids.forIntent([...review]));
    expect(ids.forIntent([...review.slice(0, 5), 3, '依据', '疑点', null])).not.toBe(ids.forIntent(review));
  });
  it('allows an explicitly new model proposal after the prior receipt was received', () => {
    let next = 0;
    const ids = createGradingRequestIds(() => `request-${++next}`);
    const intent = ['project', 1, 'attempt', 0, 'generate'];
    const first = ids.forIntent(intent);
    ids.acknowledge(first);
    expect(ids.forIntent(intent)).not.toBe(first);
  });
});
