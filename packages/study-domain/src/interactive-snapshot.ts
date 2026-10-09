/**
 * 互动快照恢复判定（OMA-045）。
 *
 * 纯函数：给定「当前组件版本」与「已存快照」，决定能否恢复。硬约束：
 * - 只有快照存在且**组件版本一致**才恢复；
 * - 版本不一致或没有快照 → 明确重置（`restored=false`），并给出机器可读原因；
 * - 快照只影响**临时现场**，不影响任何本人已提交记录（调用方据此保留正式记录）。
 */

export interface InteractiveSnapshotFacts {
  widgetVersion: string;
  data: Record<string, string | number | boolean | null>;
  updatedAt: string;
}

export type SnapshotDecisionReason = 'none' | 'widget_version_changed' | 'restored';

export interface SnapshotDecision {
  restored: boolean;
  reason: SnapshotDecisionReason;
  /** 恢复时给回快照数据；未恢复为 null。 */
  data: Record<string, string | number | boolean | null> | null;
}

export const decideInteractiveSnapshot = (input: {
  currentWidgetVersion: string;
  stored: InteractiveSnapshotFacts | null;
}): SnapshotDecision => {
  if (!input.stored) return { restored: false, reason: 'none', data: null };
  if (input.stored.widgetVersion !== input.currentWidgetVersion)
    return { restored: false, reason: 'widget_version_changed', data: null };
  return { restored: true, reason: 'restored', data: input.stored.data };
};
