const EDITING_OR_CONTROL_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], button, a, [role="button"], [role="link"], iframe';

export const shouldIgnoreClassroomShortcut = (target: EventTarget | null): boolean => {
  if (!target || !('matches' in target) || !('closest' in target)) return false;
  const element = target as Element;
  return (
    typeof element.matches === 'function' &&
    typeof element.closest === 'function' &&
    (element.matches(EDITING_OR_CONTROL_SELECTOR) ||
      element.closest(EDITING_OR_CONTROL_SELECTOR) !== null)
  );
};

export type ClassroomShortcut =
  | 'previous'
  | 'next'
  | 'first'
  | 'last'
  | 'toggle-playback'
  | 'toggle-immersive'
  | 'exit-immersive';

export const classroomShortcutFor = (
  event: Pick<
    KeyboardEvent,
    'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'target'
  >,
): ClassroomShortcut | null => {
  if (
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.repeat ||
    event.isComposing ||
    shouldIgnoreClassroomShortcut(event.target)
  )
    return null;

  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      return 'previous';
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
      return 'next';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case ' ':
    case 'Spacebar':
      return 'toggle-playback';
    case 'f':
    case 'F':
      return 'toggle-immersive';
    case 'Escape':
      return 'exit-immersive';
    default:
      return null;
  }
};
