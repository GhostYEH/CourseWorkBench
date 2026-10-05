import { describe, expect, it } from 'vitest';
import { classroomBoardEffectSchema, type ClassroomBoardEffectDto } from '@sew/study-contracts';
import { resolveActiveBoardFocus } from '../apps/learning/lib/classroom/board-focus';

const effect = (overrides: Record<string, unknown>): ClassroomBoardEffectDto =>
  classroomBoardEffectSchema.parse({
    projectId: 'proj_a',
    sessionId: 'sess_a',
    actor: 'teacher',
    at: '2026-10-05T00:00:00.000Z',
    ...overrides,
  });

const focusEffect = (seq: number, sceneId: string, elementId: string) =>
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
      content: { kind: 'focus', elementId, text: '看这里' },
      reviewNote: '',
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    },
  });

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
});
