import { describe, expect, it } from 'vitest';
import {
  classroomShortcutFor,
  shouldIgnoreClassroomShortcut,
} from '../apps/learning/components/openmaic-adaptation/classroom-interaction';

const keyEvent = (key: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    target: null,
    ...overrides,
  }) as KeyboardEvent;

describe('classroom keyboard shortcuts', () => {
  it('maps guarded navigation, playback, and immersion keys', () => {
    expect(classroomShortcutFor(keyEvent('ArrowLeft'))).toBe('previous');
    expect(classroomShortcutFor(keyEvent('PageDown'))).toBe('next');
    expect(classroomShortcutFor(keyEvent('Home'))).toBe('first');
    expect(classroomShortcutFor(keyEvent('End'))).toBe('last');
    expect(classroomShortcutFor(keyEvent(' '))).toBe('toggle-playback');
    expect(classroomShortcutFor(keyEvent('f'))).toBe('toggle-immersive');
    expect(classroomShortcutFor(keyEvent('Escape'))).toBe('exit-immersive');
  });

  it('leaves editable fields, controls, and iframe content to their owners', () => {
    for (const selector of [
      'input',
      'textarea',
      'select',
      '[contenteditable="true"]',
      'button',
      'a',
      'iframe',
    ]) {
      const element = {
        matches: (expected: string) => expected.split(', ').includes(selector),
        closest: () => null,
      } as unknown as Element;
      expect(shouldIgnoreClassroomShortcut(element)).toBe(true);
      expect(classroomShortcutFor(keyEvent('ArrowRight', { target: element }))).toBeNull();
    }
  });

  it('ignores modifiers, held repeats, and IME composition', () => {
    expect(classroomShortcutFor(keyEvent('ArrowRight', { ctrlKey: true }))).toBeNull();
    expect(classroomShortcutFor(keyEvent('ArrowRight', { repeat: true }))).toBeNull();
    expect(classroomShortcutFor(keyEvent('ArrowRight', { isComposing: true }))).toBeNull();
  });
});
