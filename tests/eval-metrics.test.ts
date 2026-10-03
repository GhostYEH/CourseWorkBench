import { describe, expect, it } from 'vitest';
import { computeBlockRate } from '../apps/learning/lib/server/eval-metrics';

describe('computeBlockRate', () => {
  it('分母为 0 时返回 N/A（rate 为 null）而不是除零', () => {
    expect(computeBlockRate([])).toEqual({ numerator: 0, denominator: 0, rate: null });
  });

  it('全阻断时分子等于分母，比率为 1', () => {
    const result = computeBlockRate([{ blocked: true }, { blocked: true }]);
    expect(result).toEqual({ numerator: 2, denominator: 2, rate: 1 });
  });

  it('部分阻断时分子、分母独立计数', () => {
    const result = computeBlockRate([{ blocked: true }, { blocked: false }, { blocked: true }]);
    expect(result.numerator).toBe(2);
    expect(result.denominator).toBe(3);
    expect(result.rate).toBeCloseTo(2 / 3, 10);
  });

  it('全部未阻断时比率为 0', () => {
    expect(computeBlockRate([{ blocked: false }, { blocked: false }])).toEqual({
      numerator: 0,
      denominator: 2,
      rate: 0,
    });
  });

  it('单个样本的边界', () => {
    expect(computeBlockRate([{ blocked: true }])).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    expect(computeBlockRate([{ blocked: false }])).toEqual({ numerator: 0, denominator: 1, rate: 0 });
  });
});
