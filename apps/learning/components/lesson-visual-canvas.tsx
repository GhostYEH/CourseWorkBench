'use client';

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import type { PlanElementDto } from '@sew/study-contracts';
import {
  applyKeyboardNudge,
  canvasPoint,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  moveGeometry,
  reorderLayer,
  resizeGeometry,
  rotationFromPointer,
} from '../lib/lesson-visual-canvas';

type Gesture = {
  pointerId: number;
  mode: 'move' | 'resize' | 'rotate';
  start: { x: number; y: number };
  initial: PlanElementDto[];
  elementId: string;
  selectedIds: string[];
  center?: { x: number; y: number };
  startingPointerAngle?: number;
  startingRotation?: number;
};

const byId = (elements: readonly PlanElementDto[], elementId: string): PlanElementDto | undefined =>
  elements.find((element) => element.elementId === elementId);

const clone = (elements: readonly PlanElementDto[]): PlanElementDto[] =>
  elements.map((element) => ({ ...element, style: { ...element.style } }));

/** Pointer-operated slide canvas. Geometry changes are committed once per gesture for useful undo. */
export const LessonVisualCanvas = ({
  elements,
  disabled,
  onCommit,
  onRemove,
}: {
  elements: PlanElementDto[];
  disabled: boolean;
  onCommit: (elements: PlanElementDto[]) => void;
  onRemove: (elementIds: string[]) => void;
}): ReactNode => {
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<PlanElementDto[]>(elements);
  const [zoom, setZoom] = useState(100);

  useEffect(() => {
    if (!gesture.current) setPreview(elements);
  }, [elements]);

  const pointFor = (event: { clientX: number; clientY: number }) => {
    const bounds = root.current?.getBoundingClientRect();
    return bounds ? canvasPoint(event.clientX, event.clientY, bounds) : { x: 0, y: 0 };
  };

  const begin = (
    event: PointerEvent<HTMLElement>,
    element: PlanElementDto,
    mode: Gesture['mode'],
  ) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    root.current?.focus();
    const ids = selected.includes(element.elementId) ? selected : [element.elementId];
    if (!selected.includes(element.elementId)) setSelected(ids);
    const start = pointFor(event);
    const center = { x: element.left + element.width / 2, y: element.top + element.height / 2 };
    const pointerAngle = (Math.atan2(start.y - center.y, start.x - center.x) * 180) / Math.PI;
    gesture.current = {
      pointerId: event.pointerId,
      mode,
      start,
      initial: clone(preview),
      elementId: element.elementId,
      selectedIds: mode === 'move' ? ids : [element.elementId],
      ...(mode === 'rotate'
        ? {
            center,
            startingPointerAngle: pointerAngle,
            startingRotation: element.rotation ?? 0,
          }
        : {}),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const point = pointFor(event);
    const delta = { x: point.x - active.start.x, y: point.y - active.start.y };
    if (active.mode === 'move') {
      setPreview(moveGeometry(active.initial, active.selectedIds, delta));
      return;
    }
    const target = byId(active.initial, active.elementId);
    if (!target) return;
    if (active.mode === 'resize') {
      const resized = resizeGeometry(target, delta);
      setPreview(
        active.initial.map((item) => (item.elementId === target.elementId ? resized : item)),
      );
      return;
    }
    const rotation = rotationFromPointer(
      point,
      active.center!,
      active.startingPointerAngle!,
      active.startingRotation!,
    );
    setPreview(
      active.initial.map((item) =>
        item.elementId === target.elementId ? { ...item, rotation } : item,
      ),
    );
  };

  const finishGesture = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const changed = JSON.stringify(active.initial) !== JSON.stringify(preview);
    gesture.current = null;
    if (changed) onCommit(clone(preview));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || selected.length === 0) return;
    if (event.key === 'Escape') {
      setSelected([]);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onRemove(selected);
      setSelected([]);
      return;
    }
    if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      onCommit(applyKeyboardNudge(preview, new Set(selected), event.key, event.shiftKey ? 10 : 1));
    }
    if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      const chosen = selected[0];
      if (chosen) onCommit(reorderLayer(preview, chosen, event.key === ']' ? 1 : -1));
    }
  };

  const changeLayer = (direction: -1 | 1) => {
    const chosen = selected[0];
    if (chosen) onCommit(reorderLayer(preview, chosen, direction));
  };

  const canvasStyle: CSSProperties = {
    position: 'relative',
    width: `${zoom}%`,
    minWidth: zoom < 70 ? '70%' : undefined,
    aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}`,
    background: 'linear-gradient(135deg, #fff 0%, #f8fafc 100%)',
    border: '1px solid #cbd5e1',
    overflow: 'hidden',
    touchAction: 'none',
    userSelect: 'none',
    containerType: 'inline-size',
  };

  return (
    <section className="card" aria-label="可视幻灯片画布">
      <div className="row-inline" style={{ justifyContent: 'space-between' }}>
        <strong>可视画布</strong>
        <div className="row-inline">
          <span className="muted">缩放</span>
          <input
            aria-label="画布缩放"
            type="range"
            min={70}
            max={150}
            step={10}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
          <span className="mono">{zoom}%</span>
          <button
            type="button"
            className="btn"
            disabled={disabled || selected.length !== 1}
            onClick={() => changeLayer(-1)}
          >
            下移图层
          </button>
          <button
            type="button"
            className="btn"
            disabled={disabled || selected.length !== 1}
            onClick={() => changeLayer(1)}
          >
            上移图层
          </button>
        </div>
      </div>
      <p className="muted">
        拖动元素移动；Shift 点击多选；方向键微调，Shift+方向键移动
        10px；角柄缩放，圆柄旋转。画布缩放只改变编辑视图。
      </p>
      <div style={{ overflow: 'auto', padding: 8 }}>
        <div
          ref={root}
          role="application"
          aria-label="幻灯片元素编辑画布"
          tabIndex={0}
          data-lesson-visual-canvas
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setSelected([]);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={finishGesture}
          style={canvasStyle}
        >
          {preview.map((element) => {
            const active = selected.includes(element.elementId);
            const style: CSSProperties = {
              position: 'absolute',
              left: `${(element.left / CANVAS_WIDTH) * 100}%`,
              top: `${(element.top / CANVAS_HEIGHT) * 100}%`,
              width: `${(element.width / CANVAS_WIDTH) * 100}%`,
              height: `${(element.height / CANVAS_HEIGHT) * 100}%`,
              transform: `rotate(${element.rotation ?? 0}deg)`,
              transformOrigin: 'center',
              zIndex: element.layerOrder ?? preview.indexOf(element),
              boxSizing: 'border-box',
              border: active ? '2px solid #2563eb' : '1px solid #94a3b8',
              borderRadius: 4,
              background: element.kind === 'image' ? '#e2e8f0' : 'rgba(255,255,255,.92)',
              color: element.style.color,
              fontSize: `${Math.max(8, (element.style.fontSize / CANVAS_WIDTH) * 100)}cqw`,
              fontWeight: element.style.bold ? 700 : 400,
              fontStyle: element.style.italic ? 'italic' : 'normal',
              textAlign: element.style.align,
              padding: 6,
              overflow: 'hidden',
              cursor: disabled ? 'default' : 'move',
              touchAction: 'none',
            };
            return (
              <div
                key={element.elementId}
                role="group"
                aria-label={`${element.kind === 'image' ? '图片' : '文本'}元素 ${element.elementId}`}
                data-visual-element={element.elementId}
                onPointerDown={(event) => {
                  if (event.shiftKey) {
                    event.preventDefault();
                    event.stopPropagation();
                    root.current?.focus();
                    setSelected((current) =>
                      current.includes(element.elementId)
                        ? current.filter((id) => id !== element.elementId)
                        : [...current, element.elementId],
                    );
                    return;
                  }
                  begin(event, element, 'move');
                }}
                style={style}
              >
                {element.kind === 'image' ? (
                  <span style={{ display: 'grid', height: '100%', placeItems: 'center' }}>
                    已审核图片 · {element.assetRef || '未填写资源编号'}
                  </span>
                ) : (
                  element.text || <span style={{ opacity: 0.5 }}>空文本元素</span>
                )}
                {active && !disabled ? (
                  <>
                    <button
                      type="button"
                      aria-label="旋转元素"
                      title="拖动旋转"
                      onPointerDown={(event) => begin(event, element, 'rotate')}
                      style={{
                        position: 'absolute',
                        left: '50%',
                        top: -15,
                        width: 14,
                        height: 14,
                        borderRadius: 20,
                        border: '1px solid #1d4ed8',
                        background: '#bfdbfe',
                        padding: 0,
                        cursor: 'grab',
                      }}
                    />
                    <button
                      type="button"
                      aria-label="调整元素尺寸"
                      title="拖动调整尺寸"
                      onPointerDown={(event) => begin(event, element, 'resize')}
                      style={{
                        position: 'absolute',
                        right: -1,
                        bottom: -1,
                        width: 14,
                        height: 14,
                        border: '1px solid #1d4ed8',
                        background: '#bfdbfe',
                        padding: 0,
                        cursor: 'nwse-resize',
                      }}
                    />
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {selected.length ? (
        <p className="muted">
          已选择 {selected.length} 个元素
          {selected.length === 1 && byId(preview, selected[0]!)?.rotation !== undefined
            ? ` · 旋转 ${byId(preview, selected[0]!)!.rotation}°`
            : ''}
          。元素拖动与键盘移动会写入计划并可撤销。
        </p>
      ) : null}
    </section>
  );
};
