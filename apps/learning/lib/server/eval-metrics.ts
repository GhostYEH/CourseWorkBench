/**
 * 评测指标计算（纯函数，便于固定样例验证）。
 *
 * 阻断率的分子与分母必须独立定义：
 * - 分母 = 全部候选数（请求总量）；
 * - 分子 = 被阻断（机械检查未通过）的候选数。
 * 分母为 0 时比率为 null，界面显示 N/A，不能除零。
 */

export interface BlockRateSample {
  blocked: boolean;
}

export interface BlockRateResult {
  numerator: number;
  denominator: number;
  /** 分母为 0 时为 null。 */
  rate: number | null;
}

export const computeBlockRate = (samples: BlockRateSample[]): BlockRateResult => {
  const denominator = samples.length;
  const numerator = samples.filter((sample) => sample.blocked).length;
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
  };
};
