import { describe, expect, it } from 'vitest';
import { classroomBoardEffectSchema, type ClassroomBoardEffectDto } from '@sew/study-contracts';
import {
  boardFocusState,
  previousBoardFocusSeq,
  resolveActiveBoardFocus,
  resolveActiveBoardLaser,
} from '../apps/learning/lib/classroom/board-focus';

const effect = (overrides: Record<string, unknown>): ClassroomBoardEffectDto =>
  classroomBoardEffectSchema.parse({
    projectId: 'proj_a',
    sessionId: 'sess_a',
    actor: 'teacher',
    at: '2026-10-05T00:00:00.000Z',
    ...overrides,
  });

const pointerEffect = (
  seq: number,
  sceneId: string,
  elementId: string,
  kind: 'focus' | 'laser' = 'focus',
) =>
  effect({
    seq,
    item: {
      projectId: 'proj_a',
      lessonId: 'lesson_a',
      lessonVersion: 3,
      sceneId,
      statementIds: ['st_1'],
      itemId: `item_${seq}`,
      version: 1,
      status: 'approved',
      content: { kind, elementId, text: kind === 'laser' ? '看这里（激光笔）' : '看这里' },
      reviewNote: '',
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    },
  });

const focusEffect = (seq: number, sceneId: string, elementId: string) =>
  pointerEffect(seq, sceneId, elementId, 'focus');

describe('canvas resolution of teacher focus', () => {
  it('ignores scenes without any focus effect', () => {
    expect(resolveActiveBoardFocus([], 'scene_1')).toBeNull();
    expect(resolveActiveBoardFocus([focusEffect(1, 'scene_2', 'el_a')], 'scene_1')).toBeNull();
  });

  it('keeps the latest played focus of the rendered scene only', () => {
    const effects = [
      focusEffect(1, 'scene_1', 'el_old'),
      focusEffect(9, 'scene_2', 'el_other'),
      focusEffect(4, 'scene_1', 'el_new'),
    ];
    expect(resolveActiveBoardFocus(effects, 'scene_1')).toEqual({
      elementId: 'el_new',
      seq: 4,
    });
    expect(resolveActiveBoardFocus(effects, 'scene_2')).toEqual({
      elementId: 'el_other',
      seq: 9,
    });
  });

  it('out-of-order playback still resolves by sequence, not array position', () => {
    const effects = [focusEffect(7, 'scene_1', 'el_late'), focusEffect(2, 'scene_1', 'el_early')];
    expect(resolveActiveBoardFocus(effects, 'scene_1')?.elementId).toBe('el_late');
  });

  it('never resolves non-focus board content', () => {
    const text = effect({
      seq: 3,
      item: {
        projectId: 'proj_a',
        lessonId: 'lesson_a',
        lessonVersion: 3,
        sceneId: 'scene_1',
        statementIds: ['st_1'],
        itemId: 'item_text',
        version: 1,
        status: 'approved',
        content: { kind: 'text', text: '普通板书' },
        reviewNote: '',
        createdAt: '2026-10-05T00:00:00.000Z',
        updatedAt: '2026-10-05T00:00:00.000Z',
      },
    });
    expect(resolveActiveBoardFocus([text], 'scene_1')).toBeNull();
  });

  it('rejects unapproved items at the contract boundary before resolution', () => {
    const draft = focusEffect(1, 'scene_1', 'el_a');
    expect(() =>
      classroomBoardEffectSchema.parse({ ...draft, item: { ...draft.item, status: 'draft' } }),
    ).toThrow();
  });

  it('laser pointers resolve separately from focus and never paint the focus highlight', () => {
    const effects = [pointerEffect(1, 'scene_1', 'el_a', 'laser')];
    expect(resolveActiveBoardFocus(effects, 'scene_1')).toBeNull();
    expect(resolveActiveBoardLaser(effects, 'scene_1')).toEqual({ elementId: 'el_a', seq: 1 });
    // 激光笔合同与聚焦同形，同样拒绝未审核内容。
    const laser = pointerEffect(1, 'scene_1', 'el_a', 'laser');
    expect(() =>
      classroomBoardEffectSchema.parse({ ...laser, item: { ...laser.item, status: 'draft' } }),
    ).toThrow();
  });

  it('retracting focus resolves to no active focus, without deleting history', () => {
    const effects = [focusEffect(1, 'scene_1', 'el_old'), focusEffect(4, 'scene_1', 'el_new')];
    // 显式收回：不高亮任何元素。
    expect(resolveActiveBoardFocus(effects, 'scene_1', null)).toBeNull();
    // 回到更早一条：只把指针移回去，历史仍保留两条。
    expect(resolveActiveBoardFocus(effects, 'scene_1', 1)).toEqual({ elementId: 'el_old', seq: 1 });
    expect(boardFocusState(effects, 'scene_1').history).toHaveLength(2);
    expect(previousBoardFocusSeq(effects, 'scene_1', 4)).toBe(1);
    expect(previousBoardFocusSeq(effects, 'scene_1', 1)).toBeNull();
  });

  it('retracts and replays laser effects with the same canvas pointer as focus', () => {
    const effects = [
      pointerEffect(1, 'scene_1', 'old', 'laser'),
      pointerEffect(4, 'scene_1', 'new', 'laser'),
    ];
    expect(resolveActiveBoardLaser(effects, 'scene_1', null)).toBeNull();
    expect(resolveActiveBoardLaser(effects, 'scene_1', 1)).toEqual({ elementId: 'old', seq: 1 });
    expect(boardFocusState(effects, 'scene_1').history).toHaveLength(2);
  });

  it('boardFocusState reports current and history per scene', () => {
    const effects = [
      focusEffect(2, 'scene_1', 'el_a'),
      focusEffect(5, 'scene_2', 'el_other'),
      pointerEffect(6, 'scene_1', 'el_b', 'laser'),
    ];
    const state = boardFocusState(effects, 'scene_1');
    expect(state.history.map((entry) => entry.seq)).toEqual([2, 6]);
    expect(state.active).toEqual({ elementId: 'el_b', seq: 6 });
    // 只按到指定 seq 为止计算当前态。
    expect(boardFocusState(effects, 'scene_1', 2).active).toEqual({ elementId: 'el_a', seq: 2 });
  });
});
