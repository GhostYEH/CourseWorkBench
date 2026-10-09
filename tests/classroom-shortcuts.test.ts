import { describe, expect, it } from 'vitest';
import { classroomShortcutFor } from '../apps/learning/components/openmaic-adaptation/classroom-interaction';

const event = (
  key: string,
  overrides: Partial<Parameters<typeof classroomShortcutFor>[0]> = {},
) => ({
  key,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  target: null,
  ...overrides,
});

describe('classroom keyboard admission', () => {
  it('maps navigation, playback and explicit fullscreen commands', () => {
    for (const key of ['ArrowLeft', 'ArrowUp', 'PageUp'])
      expect(classroomShortcutFor(event(key))).toBe('previous');
    for (const key of ['ArrowRight', 'ArrowDown', 'PageDown'])
      expect(classroomShortcutFor(event(key))).toBe('next');
    expect(classroomShortcutFor(event('Home'))).toBe('first');
    expect(classroomShortcutFor(event('End'))).toBe('last');
    expect(classroomShortcutFor(event(' '))).toBe('toggle-playback');
    expect(classroomShortcutFor(event('f'))).toBe('toggle-immersive');
    expect(classroomShortcutFor(event('Escape'))).toBe('exit-immersive');
  });
  it('does not intercept composition, repeats, modified shortcuts or controls inside editable ancestors', () => {
    for (const flag of [
      'altKey',
      'ctrlKey',
      'metaKey',
      'shiftKey',
      'repeat',
      'isComposing',
    ] as const)
      expect(classroomShortcutFor(event(' ', { [flag]: true }))).toBeNull();
    const control = { matches: () => true, closest: () => null } as unknown as EventTarget;
    const editableChild = { matches: () => false, closest: () => ({}) } as unknown as EventTarget;
    expect(classroomShortcutFor(event('ArrowRight', { target: control }))).toBeNull();
    expect(classroomShortcutFor(event('f', { target: editableChild }))).toBeNull();
  });
});
