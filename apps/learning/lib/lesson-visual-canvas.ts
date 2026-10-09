import type { PlanElementDto } from '@sew/study-contracts';

export type VisualGeometry = Pick<PlanElementDto, 'left' | 'top' | 'width' | 'height'> & {
  rotation?: number;
  layerOrder?: number;
};

export type CanvasPoint = { x: number; y: number };

export const CANVAS_WIDTH = 1000;
export const CANVAS_HEIGHT = 562.5;

export const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Math.round(value)));

export const canvasPoint = (
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
): CanvasPoint => ({
  x: (clientX - bounds.left) * (CANVAS_WIDTH / Math.max(1, bounds.width)),
  y: (clientY - bounds.top) * (CANVAS_HEIGHT / Math.max(1, bounds.height)),
});

export const moveGeometry = <T extends VisualGeometry>(
  elements: readonly T[],
  ids: readonly string[],
  delta: CanvasPoint,
): T[] => {
  const selected = new Set(ids);
  return elements.map((element) => {
    if (!selected.has(String((element as { elementId?: string }).elementId))) {
      return { ...element };
    }
    return {
      ...element,
      left: clamp(element.left + delta.x, 0, 4000),
      top: clamp(element.top + delta.y, 0, 4000),
    };
  });
};

export const resizeGeometry = <T extends VisualGeometry>(element: T, delta: CanvasPoint): T => ({
  ...element,
  width: clamp(element.width + delta.x, 20, 4000),
  height: clamp(element.height + delta.y, 20, 4000),
});

export const rotationFromPointer = (
  pointer: CanvasPoint,
  center: CanvasPoint,
  startingPointerAngle: number,
  startingRotation: number,
): number => {
  const angle = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI;
  return normalizeRotation(startingRotation + angle - startingPointerAngle);
};

export const normalizeRotation = (degrees: number): number => {
  const normalized = ((((Math.round(degrees) + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 && degrees > 0 ? 180 : normalized;
};

export const reorderLayer = <T extends VisualGeometry>(
  elements: readonly T[],
  elementId: string,
  direction: -1 | 1,
): T[] => {
  const sorted = elements
    .map((element, index) => ({ element, index }))
    .sort(
      (left, right) =>
        (left.element.layerOrder ?? left.index) - (right.element.layerOrder ?? right.index),
    );
  const index = sorted.findIndex(
    ({ element }) => (element as { elementId?: string }).elementId === elementId,
  );
  const target = index + direction;
  if (index < 0 || target < 0 || target >= sorted.length)
    return elements.map((element) => ({ ...element }));
  const [moved] = sorted.splice(index, 1);
  sorted.splice(target, 0, moved!);
  const orderById = new Map(
    sorted.map(({ element }, layerOrder) => [
      String((element as { elementId?: string }).elementId),
      layerOrder,
    ]),
  );
  return elements.map((element) => ({
    ...element,
    layerOrder: orderById.get(String((element as { elementId?: string }).elementId)) ?? 0,
  }));
};

export const applyKeyboardNudge = <T extends VisualGeometry>(
  elements: readonly T[],
  selectedIds: ReadonlySet<string>,
  key: string,
  amount: number,
): T[] => {
  const delta =
    key === 'ArrowLeft'
      ? { x: -amount, y: 0 }
      : key === 'ArrowRight'
        ? { x: amount, y: 0 }
        : key === 'ArrowUp'
          ? { x: 0, y: -amount }
          : key === 'ArrowDown'
            ? { x: 0, y: amount }
            : null;
  if (!delta) return elements.map((element) => ({ ...element }));
  const ids = [...selectedIds];
  return elements.map((element) => {
    if (!ids.includes(String((element as { elementId?: string }).elementId))) return { ...element };
    return {
      ...element,
      left: clamp(element.left + delta.x, 0, 4000),
      top: clamp(element.top + delta.y, 0, 4000),
    };
  });
};
