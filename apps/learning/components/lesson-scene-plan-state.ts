/**
 * 场景计划编辑器的纯状态机（OMA-021、OMA-022）。
 *
 * 编辑器只改「这一版课件由哪些场景、按什么顺序、每个场景里有哪些元素」，不改学科事实：
 * 陈述/题目绑定与知识点沿用冻结证据包。所有编辑都通过 `commit` 进入历史，
 * 撤销/恢复因此有确定的语义（恢复的是整份计划快照，而不是逐字段反向操作）。
 *
 * 场景编号在本地生成且稳定：排序、复制、局部重生成都不改已有场景的身份。
 */

import type { PlanElementDto, PlanElementStyleDto, PlanSceneDto } from '@sew/study-contracts';

export interface ScenePlanEditorState {
  scenes: PlanSceneDto[];
  /** 撤销栈：每项是提交前的一份完整场景快照。 */
  past: PlanSceneDto[][];
  /** 恢复栈：撤销后可以重做。 */
  future: PlanSceneDto[][];
}

const HISTORY_LIMIT = 50;

const cloneScenes = (scenes: readonly PlanSceneDto[]): PlanSceneDto[] =>
  scenes.map((scene) => ({
    ...scene,
    knowledgeIds: [...scene.knowledgeIds],
    elements: scene.elements.map((element) => ({ ...element, style: { ...element.style } })),
  }));

export const createEditorState = (scenes: readonly PlanSceneDto[]): ScenePlanEditorState => ({
  scenes: cloneScenes(scenes),
  past: [],
  future: [],
});

/** 提交一次编辑：当前快照入撤销栈，恢复栈清空（新的分支不再是「重做」）。 */
export const commit = (
  state: ScenePlanEditorState,
  scenes: readonly PlanSceneDto[],
): ScenePlanEditorState => ({
  scenes: cloneScenes(scenes),
  past: [...state.past, state.scenes].slice(-HISTORY_LIMIT),
  future: [],
});

export const canUndo = (state: ScenePlanEditorState): boolean => state.past.length > 0;
export const canRedo = (state: ScenePlanEditorState): boolean => state.future.length > 0;

export const undo = (state: ScenePlanEditorState): ScenePlanEditorState => {
  if (state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1]!;
  return {
    scenes: previous,
    past: state.past.slice(0, -1),
    future: [state.scenes, ...state.future].slice(0, HISTORY_LIMIT),
  };
};

export const redo = (state: ScenePlanEditorState): ScenePlanEditorState => {
  if (state.future.length === 0) return state;
  const next = state.future[0]!;
  return {
    scenes: next,
    past: [...state.past, state.scenes].slice(-HISTORY_LIMIT),
    future: state.future.slice(1),
  };
};

const randomToken = (): string => {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID().replace(/-/g, '').slice(0, 20);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 20);
};

export const newSceneId = (kind: string): string => `scene_${kind}_${randomToken()}`;
export const newElementId = (): string => `el_text_${randomToken()}`;

export const DEFAULT_ELEMENT_STYLE: PlanElementStyleDto = {
  fontSize: 24,
  color: '#232323',
  bold: false,
  italic: false,
  align: 'left',
};

/** 新建一个空白文本元素：位置按已有元素数量错开，避免完全重叠。 */
export const makeElement = (index: number): PlanElementDto => ({
  elementId: newElementId(),
  kind: 'text',
  text: '',
  assetRef: null,
  left: 90,
  top: 130 + index * 110,
  width: 820,
  height: 100,
  style: { ...DEFAULT_ELEMENT_STYLE },
});

/** 复制场景：正文逐字保留，但场景与元素的编号必须是新的。 */
export const duplicateSceneAt = (
  scenes: readonly PlanSceneDto[],
  sceneId: string,
): PlanSceneDto[] => {
  const index = scenes.findIndex((scene) => scene.sceneId === sceneId);
  if (index < 0) return cloneScenes(scenes);
  const source = scenes[index]!;
  const copy: PlanSceneDto = {
    ...source,
    sceneId: newSceneId(source.kind),
    elements: source.elements.map((element) => ({
      ...element,
      elementId: newElementId(),
      style: { ...element.style },
    })),
  };
  const next = cloneScenes(scenes);
  next.splice(index + 1, 0, copy);
  return next;
};

export const removeSceneAt = (scenes: readonly PlanSceneDto[], sceneId: string): PlanSceneDto[] => {
  const next = cloneScenes(scenes).filter((scene) => scene.sceneId !== sceneId);
  return next;
};

export const moveScene = (
  scenes: readonly PlanSceneDto[],
  sceneId: string,
  direction: -1 | 1,
): PlanSceneDto[] => {
  const index = scenes.findIndex((scene) => scene.sceneId === sceneId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= scenes.length) return cloneScenes(scenes);
  const next = cloneScenes(scenes);
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
};

export const updateScene = (
  scenes: readonly PlanSceneDto[],
  sceneId: string,
  patch: Partial<Pick<PlanSceneDto, 'title' | 'note'>>,
): PlanSceneDto[] =>
  cloneScenes(scenes).map((scene) => (scene.sceneId === sceneId ? { ...scene, ...patch } : scene));

export const addElement = (scenes: readonly PlanSceneDto[], sceneId: string): PlanSceneDto[] =>
  cloneScenes(scenes).map((scene) =>
    scene.sceneId === sceneId
      ? { ...scene, elements: [...scene.elements, makeElement(scene.elements.length)] }
      : scene,
  );

export const updateElement = (
  scenes: readonly PlanSceneDto[],
  sceneId: string,
  elementId: string,
  patch: Omit<Partial<PlanElementDto>, 'style'> & { style?: Partial<PlanElementStyleDto> },
): PlanSceneDto[] =>
  cloneScenes(scenes).map((scene) =>
    scene.sceneId === sceneId
      ? {
          ...scene,
          elements: scene.elements.map((element) =>
            element.elementId === elementId
              ? { ...element, ...patch, style: { ...element.style, ...(patch.style ?? {}) } }
              : element,
          ),
        }
      : scene,
  );

export const removeElement = (
  scenes: readonly PlanSceneDto[],
  sceneId: string,
  elementId: string,
): PlanSceneDto[] =>
  cloneScenes(scenes).map((scene) =>
    scene.sceneId === sceneId
      ? { ...scene, elements: scene.elements.filter((element) => element.elementId !== elementId) }
      : scene,
  );

/**
 * 局部重生成：只替换目标场景的元素集合，其余场景逐字保留。
 * 传入的元素已由调用方（服务端）按正文生成，这里只做替换与编号保留。
 */
export const applyPartialRegeneration = (
  scenes: readonly PlanSceneDto[],
  sceneId: string,
  elements: PlanElementDto[],
): PlanSceneDto[] =>
  cloneScenes(scenes).map((scene) => (scene.sceneId === sceneId ? { ...scene, elements } : scene));

/** 把计划序列化成可提交给服务端的形状：去掉本地编辑态，只保留权威字段。 */
export const scenesForSubmit = (scenes: readonly PlanSceneDto[]): PlanSceneDto[] =>
  scenes.map((scene) => ({
    sceneId: scene.sceneId,
    kind: scene.kind,
    title: scene.title,
    statementId: scene.statementId,
    questionId: scene.questionId,
    knowledgeIds: [...scene.knowledgeIds],
    elements: scene.elements.map((element) => ({ ...element, style: { ...element.style } })),
    note: scene.note,
  }));
