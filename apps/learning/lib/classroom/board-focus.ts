import type { ClassroomBoardEffectDto } from '@sew/study-contracts';

export interface ActiveBoardFocus {
  elementId: string;
  seq: number;
}

/**
 * 教师聚焦只在它指向的那个冻结场景里生效：同一场景取已播放效果中 seq 最大的一条。
 * 白板效果合同已保证「审核通过且项目相符」，这里不再采信任何客户端字段。
 */
export const resolveActiveBoardFocus = (
  effects: readonly ClassroomBoardEffectDto[],
  sceneId: string,
): ActiveBoardFocus | null => {
  let active: ActiveBoardFocus | null = null;
  for (const effect of effects) {
    const content = effect.item.content;
    if (content.kind !== 'focus' || effect.item.sceneId !== sceneId) continue;
    if (!active || effect.seq > active.seq) active = { elementId: content.elementId, seq: effect.seq };
  }
  return active;
};
