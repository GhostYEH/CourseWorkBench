import type { ClassroomBoardEffectDto } from '@sew/study-contracts';

export interface ActiveBoardFocus {
  elementId: string;
  seq: number;
}

/**
 * 生效的聚焦/激光笔：默认取同场景 seq 最大的一条；`atSeq` 给定时取「不超过该 seq 的最后一条」。
 * `atSeq === null` 表示教师显式收回（不高亮任何元素）。
 * 白板效果合同已保证「审核通过且项目相符」，这里不再采信任何客户端字段。
 */
const activeAtSeq = (
  effects: readonly ClassroomBoardEffectDto[],
  sceneId: string,
  kind: 'focus' | 'laser',
  atSeq: number | null | undefined,
): ActiveBoardFocus | null => {
  if (atSeq === null) return null;
  let active: ActiveBoardFocus | null = null;
  for (const effect of effects) {
    const content = effect.item.content;
    if (content.kind !== kind || effect.item.sceneId !== sceneId) continue;
    if (atSeq !== undefined && effect.seq > atSeq) continue;
    if (!active || effect.seq > active.seq)
      active = { elementId: content.elementId, seq: effect.seq };
  }
  return active;
};

/** 当前生效的教师聚焦。`atSeq` 省略 = 取最新；`null` = 收回。 */
export const resolveActiveBoardFocus = (
  effects: readonly ClassroomBoardEffectDto[],
  sceneId: string,
  atSeq?: number | null,
): ActiveBoardFocus | null => activeAtSeq(effects, sceneId, 'focus', atSeq);

/** 当前生效的激光笔（同场景 seq 最大的一条 `laser`）。与聚焦分开，不改变元素呈现。 */
export const resolveActiveBoardLaser = (
  effects: readonly ClassroomBoardEffectDto[],
  sceneId: string,
  atSeq?: number | null,
): ActiveBoardFocus | null => activeAtSeq(effects, sceneId, 'laser', atSeq);

export interface BoardFocusState {
  /** 当前生效的指针（同场景 seq 最大的一条聚焦或激光笔），没有时为 null。 */
  active: ActiveBoardFocus | null;
  /** 本场景的全部指针效果（聚焦 + 激光笔），按 seq 升序；界面据此提供「按动作撤销/重放」。 */
  history: Array<{ elementId: string; seq: number; text: string; kind: 'focus' | 'laser' }>;
}

/**
 * 指针效果的**历史与当前态**分开给出（OMA-032 的「按动作撤销/重放」）。
 *
 * 撤销不是删除历史，而是「把更早的一条重新放回生效位」：调用方给出要生效的那条 effect 的 seq，
 * 这里返回「以该 seq 为界」的当前态与历史。传入 `atSeq` 为 null 表示收回（不高亮任何元素）。
 * 文档中不存在的 id 一律不参与（`elementId` 必须是当前场景真实存在的元素，由调用方先核对）。
 */
export const boardFocusState = (
  effects: readonly ClassroomBoardEffectDto[],
  sceneId: string,
  atSeq: number | null = null,
): BoardFocusState => {
  const history = effects
    .filter(
      (effect) =>
        effect.item.sceneId === sceneId &&
        (effect.item.content.kind === 'focus' || effect.item.content.kind === 'laser'),
    )
    .filter((effect) => atSeq === null || effect.seq <= atSeq)
    .sort((left, right) => left.seq - right.seq)
    .map((effect) => ({
      elementId: (effect.item.content as { elementId: string }).elementId,
      seq: effect.seq,
      text: (effect.item.content as { text: string }).text,
      kind: effect.item.content.kind as 'focus' | 'laser',
    }));
  const latest = history.at(-1) ?? null;
  return { active: latest ? { elementId: latest.elementId, seq: latest.seq } : null, history };
};

/**
 * 撤销最近一次指针：返回「应当生效」的 seq。
 *
 * 只回退指针这一层，不删除已提交的效果记录（历史必须保留供复核）。没有更早的指针时返回 null，
 * 表示「回到没有指针」——界面据此收回画布高亮，而不是凭空指向别的元素。
 */
export const previousBoardFocusSeq = (
  effects: readonly ClassroomBoardEffectDto[],
  sceneId: string,
  currentSeq: number,
): number | null => {
  const earlier = effects
    .filter(
      (effect) =>
        effect.item.sceneId === sceneId &&
        (effect.item.content.kind === 'focus' || effect.item.content.kind === 'laser'),
    )
    .filter((effect) => effect.seq < currentSeq)
    .sort((left, right) => left.seq - right.seq);
  return earlier.at(-1)?.seq ?? null;
};
