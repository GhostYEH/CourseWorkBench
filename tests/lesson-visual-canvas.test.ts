import { describe, expect, it } from 'vitest';
import { planElementSchema } from '@sew/study-contracts';
import { scenePlanDigest } from '@sew/study-domain';
import type { PlanElementDto } from '@sew/study-contracts';
import {
  applyKeyboardNudge,
  canvasPoint,
  moveGeometry,
  normalizeRotation,
  reorderLayer,
  resizeGeometry,
  rotationFromPointer,
} from '../apps/learning/lib/lesson-visual-canvas';
import {
  commit,
  createEditorState,
  redo,
  undo,
} from '../apps/learning/components/lesson-scene-plan-state';

const element = (elementId: string, left: number): PlanElementDto => ({
  elementId,
  kind: 'text',
  text: elementId,
  assetRef: null,
  left,
  top: 100,
  width: 200,
  height: 80,
  style: { fontSize: 24, color: '#232323', bold: false, italic: false, align: 'left' },
});

describe('lesson visual canvas geometry', () => {
  it('maps pointer pixels to the stable 1000 x 562.5 slide space', () => {
    expect(canvasPoint(110, 70, { left: 10, top: 20, width: 500, height: 281.25 })).toEqual({
      x: 200,
      y: 100,
    });
  });

  it('moves a multi-selection together and clamps it to the plan coordinate bounds', () => {
    const input = [element('el_a', 10), element('el_b', 3900), element('el_c', 500)];
    const moved = moveGeometry(input, ['el_a', 'el_b'], { x: -30, y: 45 });
    expect(moved.map(({ left, top }) => [left, top])).toEqual([
      [0, 145],
      [3870, 145],
      [500, 100],
    ]);
  });

  it('resizes within valid sizes and computes pointer rotation relative to the gesture start', () => {
    expect(resizeGeometry(element('el_a', 1), { x: -500, y: 30 })).toMatchObject({
      width: 20,
      height: 110,
    });
    expect(rotationFromPointer({ x: 0, y: 1 }, { x: 0, y: 0 }, 0, 30)).toBe(120);
    expect(normalizeRotation(540)).toBe(180);
  });

  it('supports multi-element keyboard nudges and persists a deterministic painter order', () => {
    const input = [element('el_a', 10), element('el_b', 100)];
    const nudged = applyKeyboardNudge(input, new Set(['el_a', 'el_b']), 'ArrowRight', 10);
    expect(nudged.map(({ left }) => left)).toEqual([20, 110]);
    const reordered = reorderLayer(input, 'el_a', 1);
    expect(reordered.map(({ layerOrder }) => layerOrder)).toEqual([1, 0]);
    expect(
      reordered
        .map((item, index) => ({ item, index }))
        .sort(
          (left, right) =>
            (left.item.layerOrder ?? left.index) - (right.item.layerOrder ?? right.index),
        )
        .map(({ item }) => item.elementId),
    ).toEqual(['el_b', 'el_a']);
  });

  it('records a multi-selection geometry gesture as one undoable plan edit', () => {
    const scene = {
      sceneId: 'scene_slide_a',
      kind: 'slide' as const,
      title: 'Slide',
      statementId: 'statement_a',
      questionId: null,
      knowledgeIds: ['knowledge_a'],
      elements: [element('el_a', 10), element('el_b', 100)],
      note: '',
    };
    const initial = createEditorState([scene]);
    const moved = moveGeometry(scene.elements, ['el_a', 'el_b'], { x: 12, y: 0 });
    const edited = commit(initial, [{ ...scene, elements: moved }]);

    expect(edited.scenes[0]!.elements.map(({ left }) => left)).toEqual([22, 112]);
    expect(undo(edited).scenes[0]!.elements.map(({ left }) => left)).toEqual([10, 100]);
    expect(redo(undo(edited)).scenes[0]!.elements.map(({ left }) => left)).toEqual([22, 112]);
  });

  it('accepts legacy geometry without adding fields, and validates optional new geometry', () => {
    const legacy = element('el_a', 10);
    const parsed = planElementSchema.parse(legacy);
    expect(parsed).not.toHaveProperty('rotation');
    expect(parsed).not.toHaveProperty('layerOrder');
    expect(planElementSchema.safeParse({ ...legacy, rotation: 45, layerOrder: 0 }).success).toBe(
      true,
    );
    expect(planElementSchema.safeParse({ ...legacy, rotation: 181 }).success).toBe(false);

    const scene = {
      sceneId: 'scene_slide_a',
      kind: 'slide' as const,
      title: 'Slide',
      statementId: 'statement_a',
      questionId: null,
      knowledgeIds: ['knowledge_a'],
      elements: [legacy],
      note: '',
    };
    const base = { lessonId: 'lesson_a', lessonVersion: 1, bundleId: 'bundle_a', scenes: [scene] };
    expect(
      scenePlanDigest({
        ...base,
        scenes: [
          { ...scene, elements: [{ ...legacy, rotation: undefined, layerOrder: undefined }] },
        ],
      }),
    ).toBe(scenePlanDigest(base));
    expect(
      scenePlanDigest({ ...base, scenes: [{ ...scene, elements: [{ ...legacy, rotation: 15 }] }] }),
    ).not.toBe(scenePlanDigest(base));
  });
});
