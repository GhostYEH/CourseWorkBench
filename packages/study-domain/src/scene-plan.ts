/**
 * 场景计划的纯判断（LESSON-02 / OMA-006、OMA-021、OMA-022）。
 *
 * 这一层不碰 IO、不依赖框架：它只回答
 * - 计划的场景集合是否与冻结证据包相容（陈述/题目必须在本版本已选范围内）；
 * - 场景编号是否稳定（增删/排序/复制/局部重生成都不改已有场景身份）；
 * - 富文本是否只含白名单行内标记（不能让课件正文变成可执行内容）；
 * - 模型输出的计划是否可被接受为「候选」（编号与来源必须由服务端沿用）。
 */

import { StudyError } from '@sew/study-contracts';
import type { EvidenceBundleDto, FormalInteractionDefinitionDto } from '@sew/study-contracts';
import { RICH_TEXT_TAGS, SCENE_PLAN_WRITE_LIMIT } from '@sew/study-contracts';
import type { PlanElementDto, PlanSceneDto, ScenePlanDto } from '@sew/study-contracts';
import { canonicalJson } from './classroom';
import { formalInteractionSceneId } from './formal-interaction';
import { fingerprintOf } from './normalize';

/** 单份计划的场景上限：与正式课件装配的 `FORMAL_SCENE_LIMIT` 对齐，异常大的输入直接拒绝。 */
export const SCENE_PLAN_LIMIT = SCENE_PLAN_WRITE_LIMIT;

const TAG_PATTERN = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
const EVENT_ATTRIBUTE_PATTERN = /\son[a-z]+\s*=/i;
const DANGEROUS_SCHEME_PATTERN = /(?:javascript|data|vbscript)\s*:/i;

/**
 * 富文本校验：只允许白名单行内标记，禁止事件属性、脚本协议与未知标签。
 *
 * 这里不「清洗」后放行，而是拒绝：清洗会掩盖调用方提交了危险内容这件事，
 * 而课件的正文要么是审核过的安全文本，要么就不该进入计划。
 */
export const assertRichTextSafe = (text: string): void => {
  if (EVENT_ATTRIBUTE_PATTERN.test(text) || DANGEROUS_SCHEME_PATTERN.test(text)) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'rich_text_unsafe' });
  }
  for (const match of text.matchAll(TAG_PATTERN)) {
    const tag = (match[1] ?? '').toLowerCase();
    if (!(RICH_TEXT_TAGS as readonly string[]).includes(tag)) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'rich_text_tag_not_allowed', tag });
    }
  }
};

/** 文本元素正文必须是安全富文本；图片元素不承载正文。 */
export const assertElementSafe = (element: PlanElementDto): void => {
  if (element.kind === 'text') {
    assertRichTextSafe(element.text);
    return;
  }
  if (element.text !== '') {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'image_element_has_text' });
  }
  if (!element.assetRef) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'image_element_missing_asset' });
  }
  if (/[A-Za-z]:[\\/]|^\/(?!\/)|\\\\/.test(element.assetRef)) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'asset_ref_must_be_symbolic' });
  }
};

/**
 * 计划必须与冻结证据包相容。
 *
 * 幻灯片只能绑定本版本已选中的陈述，测验只能绑定本版本已选中的题目；否则计划就是在讲
 * 这节课之外的内容。知识点由服务端从绑定对象沿用，客户端提交的 `knowledgeIds` 只作核对，
 * 与服务端派生结果不一致即拒绝（不能靠客户端自报知识点扩大范围）。
 */
export const assertPlanGrounded = (
  scenes: readonly PlanSceneDto[],
  facts: {
    bundle: EvidenceBundleDto;
    /** 本版本已选中的陈述/题目；缺省表示不额外收窄（用于新建计划）。 */
    statementIds?: readonly string[];
    questionIds?: readonly string[];
  },
): void => {
  if (scenes.length === 0)
    throw new StudyError('INVALID_ARGUMENT', { reason: 'plan_has_no_scenes' });
  if (scenes.length > SCENE_PLAN_LIMIT) {
    throw new StudyError('INVALID_ARGUMENT', {
      reason: 'plan_scene_limit',
      limit: SCENE_PLAN_LIMIT,
    });
  }
  const statements = new Map(facts.bundle.statements.map((item) => [item.statementId, item]));
  const questions = new Map(facts.bundle.questions.map((item) => [item.questionId, item]));
  const allowedStatements = facts.statementIds ? new Set(facts.statementIds) : null;
  const allowedQuestions = facts.questionIds ? new Set(facts.questionIds) : null;
  const seen = new Set<string>();

  for (const scene of scenes) {
    if (seen.has(scene.sceneId)) {
      throw new StudyError('INVALID_ARGUMENT', {
        reason: 'plan_duplicate_scene_id',
        sceneId: scene.sceneId,
      });
    }
    seen.add(scene.sceneId);

    const expectedKnowledge: string[] = [];
    if (scene.kind === 'slide') {
      if (!scene.statementId) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'slide_scene_needs_statement',
          sceneId: scene.sceneId,
        });
      }
      if (scene.questionId) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'slide_scene_has_question',
          sceneId: scene.sceneId,
        });
      }
      const statement = statements.get(scene.statementId);
      if (!statement) {
        throw new StudyError('SOURCE_MISSING', {
          reason: 'statement_not_in_bundle',
          statementId: scene.statementId,
        });
      }
      if (allowedStatements && !allowedStatements.has(scene.statementId)) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'plan_statement_not_in_version',
          statementId: scene.statementId,
        });
      }
      expectedKnowledge.push(statement.knowledgeId);
      for (const element of scene.elements) assertElementSafe(element);
    } else if (scene.kind === 'quiz') {
      if (!scene.questionId) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'quiz_scene_needs_question',
          sceneId: scene.sceneId,
        });
      }
      if (scene.statementId) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'quiz_scene_has_statement',
          sceneId: scene.sceneId,
        });
      }
      const question = questions.get(scene.questionId);
      if (!question) {
        throw new StudyError('NOT_FOUND', {
          reason: 'question_not_in_bundle',
          questionId: scene.questionId,
        });
      }
      if (allowedQuestions && !allowedQuestions.has(scene.questionId)) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'plan_question_not_in_version',
          questionId: scene.questionId,
        });
      }
      if (scene.elements.length > 0) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'quiz_scene_has_elements',
          sceneId: scene.sceneId,
        });
      }
      expectedKnowledge.push(...question.knowledgeIds);
    } else {
      // 互动/PBL 场景不绑定单条陈述或题目，知识点由服务端沿用为空，不得由客户端自报。
      if (scene.statementId || scene.questionId) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'scene_binding_not_allowed',
          sceneId: scene.sceneId,
        });
      }
      if (scene.elements.length > 0) {
        throw new StudyError('INVALID_ARGUMENT', {
          reason: 'scene_elements_not_allowed',
          sceneId: scene.sceneId,
        });
      }
    }

    const expected = [...new Set(expectedKnowledge)].sort();
    const declared = [...new Set(scene.knowledgeIds)].sort();
    if (
      expected.length !== declared.length ||
      expected.some((id, index) => id !== declared[index])
    ) {
      throw new StudyError('KNOWLEDGE_SCOPE_INVALID', {
        reason: 'plan_knowledge_mismatch',
        sceneId: scene.sceneId,
        expected,
        declared,
      });
    }
  }
};

/** 场景顺序规范化为数组下标：排序是计划的唯一权威，不靠场景自带的 order 字段。 */
export const normalizeSceneOrder = (scenes: readonly PlanSceneDto[]): PlanSceneDto[] => [...scenes];

/**
 * 计划**内容**的稳定摘要。
 *
 * 只由「这节课讲哪些场景、按什么顺序、每个场景怎么写」决定，不含 `revision`、`origin` 与
 * `updatedAt`：同一份内容无论保存几次、由确定性装配还是模型候选写入，摘要都相同；内容一变
 * 摘要立刻变。审核结论与发布复核都绑定它，因此「保存一次但内容没变」不会误伤旧审核，
 * 而「改了场景或正文」必然让旧审核失效。
 */
export const scenePlanDigest = (plan: {
  lessonId: string;
  lessonVersion: number;
  bundleId: string;
  scenes: readonly PlanSceneDto[];
}): string =>
  fingerprintOf(
    canonicalJson({
      lessonId: plan.lessonId,
      lessonVersion: plan.lessonVersion,
      bundleId: plan.bundleId,
      scenes: plan.scenes.map((scene) => ({
        sceneId: scene.sceneId,
        kind: scene.kind,
        title: scene.title,
        statementId: scene.statementId,
        questionId: scene.questionId,
        knowledgeIds: [...scene.knowledgeIds].sort(),
        note: scene.note,
        elements: scene.elements.map((element) => ({
          elementId: element.elementId,
          kind: element.kind,
          text: element.text,
          assetRef: element.assetRef,
          left: element.left,
          top: element.top,
          width: element.width,
          height: element.height,
          style: {
            fontSize: element.style.fontSize,
            color: element.style.color.toLowerCase(),
            bold: element.style.bold,
            italic: element.style.italic,
            align: element.style.align,
          },
        })),
      })),
    }),
  );

/** 计划当前的内容摘要（读回计划自身）。 */
export const digestOfScenePlan = (
  plan: Pick<ScenePlanDto, 'lessonId' | 'lessonVersion' | 'bundleId' | 'scenes'>,
): string => scenePlanDigest(plan);

/**
 * 单个场景的**内容**摘要（含顺序无关的自身字段）。
 *
 * 差异比较与三向合并都以它为准：同一 sceneId 的正文、绑定、知识点或元素变了就算「这个场景被改过」，
 * 而不是只看场景标题或序号。`knowledgeIds` 排序后参与，顺序不同不算改动（顺序由计划数组决定）。
 */
export const planSceneDigest = (scene: PlanSceneDto): string =>
  fingerprintOf(
    canonicalJson({
      sceneId: scene.sceneId,
      kind: scene.kind,
      title: scene.title,
      statementId: scene.statementId,
      questionId: scene.questionId,
      knowledgeIds: [...scene.knowledgeIds].sort(),
      note: scene.note,
      elements: scene.elements.map((element) => ({
        elementId: element.elementId,
        kind: element.kind,
        text: element.text,
        assetRef: element.assetRef,
        left: element.left,
        top: element.top,
        width: element.width,
        height: element.height,
        style: {
          fontSize: element.style.fontSize,
          color: element.style.color.toLowerCase(),
          bold: element.style.bold,
          italic: element.style.italic,
          align: element.style.align,
        },
      })),
    }),
  );

export interface PlanSceneChange {
  sceneId: string;
  /** 该场景在两侧的摘要；缺席一侧为 null。 */
  baseDigest: string | null;
  targetDigest: string | null;
}

export interface ScenePlanDiff {
  added: string[];
  removed: string[];
  modified: string[];
  reordered: boolean;
  /** 逐场景的变化明细（含两侧摘要），便于界面把「哪一版改了什么」直接显示出来。 */
  changes: PlanSceneChange[];
}

const orderedIds = (scenes: readonly PlanSceneDto[]): string[] =>
  scenes.map((scene) => scene.sceneId);

/**
 * 两份计划之间的差异（OMA-005 / OMA-022 的「跨版本计划差异」）。
 *
 * 只按稳定 `sceneId` 比较，不看序号：增/删/改/序四类分别列出，界面据此显示
 * 「v2 相对 v1 增加了什么、删掉了什么、改了哪些场景、顺序是否变化」，而不是重放一遍编辑操作。
 * 这是一个纯函数，不做任何取舍——是否把差异合并进新版由用户明确决定。
 */
export const diffScenePlans = (
  base: readonly PlanSceneDto[],
  target: readonly PlanSceneDto[],
): ScenePlanDiff => {
  const baseById = new Map(base.map((scene) => [scene.sceneId, scene]));
  const targetById = new Map(target.map((scene) => [scene.sceneId, scene]));
  const added = orderedIds(target).filter((id) => !baseById.has(id));
  const removed = orderedIds(base).filter((id) => !targetById.has(id));
  const modified: string[] = [];
  const changes: PlanSceneChange[] = [];
  for (const scene of target) {
    const before = baseById.get(scene.sceneId);
    if (!before) continue;
    const baseDigest = planSceneDigest(before);
    const targetDigest = planSceneDigest(scene);
    changes.push({ sceneId: scene.sceneId, baseDigest, targetDigest });
    if (baseDigest !== targetDigest) modified.push(scene.sceneId);
  }
  for (const scene of base) {
    if (targetById.has(scene.sceneId)) continue;
    changes.push({
      sceneId: scene.sceneId,
      baseDigest: planSceneDigest(scene),
      targetDigest: null,
    });
  }
  // 顺序比较只看两侧都存在的场景，避免「新增/删除」被误报成「顺序变了」。
  const common = new Set(orderedIds(base).filter((id) => targetById.has(id)));
  const reordered =
    orderedIds(base)
      .filter((id) => common.has(id))
      .join('\u0000') !==
    orderedIds(target)
      .filter((id) => common.has(id))
      .join('\u0000');
  return { added, removed, modified, reordered, changes };
};

export interface PlanMergeConflict {
  sceneId: string;
  reason: 'both_modified' | 'kind_changed' | 'removed_and_modified' | 'added_duplicate';
}

export interface PlanMergeResult {
  /** 合并后的场景数组：按当前（较新版本）计划的顺序为骨架，叠加可安全应用的改动。 */
  scenes: PlanSceneDto[];
  /** 无法自动判定的冲突：必须由用户逐条确认，绝不静默取一侧。 */
  conflicts: PlanMergeConflict[];
  applied: { added: string[]; removed: string[]; replaced: string[] };
}

const assertUniqueSceneIds = (scenes: readonly PlanSceneDto[]): void => {
  const seen = new Set<string>();
  for (const scene of scenes) {
    if (seen.has(scene.sceneId)) {
      throw new StudyError('INVALID_ARGUMENT', {
        reason: 'plan_duplicate_scene_id',
        sceneId: scene.sceneId,
      });
    }
    seen.add(scene.sceneId);
  }
};

/**
 * 跨版本计划的三向合并（OMA-005 / OMA-022）。
 *
 * 三方分别是：`base`（旧版本计划，即被合并版本的基线）、`incoming`（旧版本上累积的编辑）、
 * `current`（当前草案版本的计划）。语义与文本三向合并一致，但以稳定 `sceneId` 为对齐键：
 *
 * - 只有 incoming 相对 base 改了、current 没动 → 安全应用 incoming 的改动；
 * - 两侧都改了同一个场景 / 场景种类被换掉 / 一侧删除而另一侧改过 → 记为冲突，
 *   结果里**保留 current 的内容**并如实报告，绝不静默用某一侧覆盖另一侧；
 * - current 已删除、而 incoming 未改动的场景保持删除（不因合并回加被显式删掉的场景）；
 * - incoming 新增的场景按 incoming 顺序追加到末尾。
 *
 * 合并只产出计划内容；写回、审核与发布仍走原有「计划只挂草案版本、新版本必须重审」的路径。
 */
export const mergeScenePlans = (input: {
  base: readonly PlanSceneDto[];
  incoming: readonly PlanSceneDto[];
  current: readonly PlanSceneDto[];
}): PlanMergeResult => {
  const { base, incoming, current } = input;
  assertUniqueSceneIds(base);
  assertUniqueSceneIds(incoming);
  assertUniqueSceneIds(current);
  const baseById = new Map(base.map((scene) => [scene.sceneId, scene]));
  const incomingById = new Map(incoming.map((scene) => [scene.sceneId, scene]));
  const currentById = new Map(current.map((scene) => [scene.sceneId, scene]));

  const conflicts: PlanMergeConflict[] = [];
  const applied = { added: [] as string[], removed: [] as string[], replaced: [] as string[] };
  const result: PlanSceneDto[] = [];

  for (const scene of current) {
    const before = baseById.get(scene.sceneId);
    const after = incomingById.get(scene.sceneId);
    // 只在当前版本里存在（base 与 incoming 都没有）→ 是这一版自己的新增，原样保留。
    if (!before && !after) {
      result.push(scene);
      continue;
    }
    // incoming 明确删除：只有 current 相对 base 未改动时才跟着删，否则是「删改冲突」。
    if (before && !after) {
      if (planSceneDigest(before) === planSceneDigest(scene)) {
        applied.removed.push(scene.sceneId);
        continue;
      }
      conflicts.push({ sceneId: scene.sceneId, reason: 'removed_and_modified' });
      result.push(scene);
      continue;
    }
    // base 与 incoming 都新增了同一编号：内容一致就当同一场景，否则要求人工确认。
    if (!before && after) {
      if (planSceneDigest(after) !== planSceneDigest(scene)) {
        conflicts.push({ sceneId: scene.sceneId, reason: 'added_duplicate' });
      }
      result.push(scene);
      continue;
    }
    if (after!.kind !== scene.kind) {
      conflicts.push({ sceneId: scene.sceneId, reason: 'kind_changed' });
      result.push(scene);
      continue;
    }
    const incomingChanged = planSceneDigest(after!) !== planSceneDigest(before!);
    if (!incomingChanged) {
      result.push(scene);
      continue;
    }
    if (planSceneDigest(scene) !== planSceneDigest(before!)) {
      conflicts.push({ sceneId: scene.sceneId, reason: 'both_modified' });
      result.push(scene);
      continue;
    }
    result.push(after!);
    applied.replaced.push(scene.sceneId);
  }

  // incoming 相对 base 新增的场景：current 里没有的追加到末尾（顺序按 incoming）。
  // 「两侧新增了同一编号」已在主循环里按内容差异判过，这里不重复报告。
  //
  // 顺序由目标（current）版本决定：`diffScenePlans` 会如实报告 `reordered`，合并本身不静默重排
  // ——重排是「按整课大纲批量重生成」（`outlineOrderedScenes`）或用户显式操作的事。
  for (const scene of incoming) {
    if (currentById.has(scene.sceneId)) continue;
    const before = baseById.get(scene.sceneId);
    if (before) {
      // 目标已删、来源仍修改了祖先场景：保留目标删除，同时报告反向删改冲突。
      if (planSceneDigest(before) !== planSceneDigest(scene)) {
        conflicts.push({ sceneId: scene.sceneId, reason: 'removed_and_modified' });
      }
      continue;
    }
    result.push(scene);
    applied.added.push(scene.sceneId);
  }

  return { scenes: result, conflicts, applied };
};

/**
 * 按整课大纲批量重排（OMA-022 的「按整课大纲批量重生成」骨架）。
 *
 * 只做一件确定性的事：把「证据包里已选陈述的顺序」当作大纲，重排计划里已存在的幻灯片场景，
 * 并报告哪些已选陈述还没有对应场景。它不新增事实、不生成正文——缺失的场景由用户或模型候选补齐，
 * 因此这里是纯顺序对齐，不是静默补场景。
 */
export const outlineOrderedScenes = (
  scenes: readonly PlanSceneDto[],
  outlineStatementIds: readonly string[],
): { scenes: PlanSceneDto[]; missing: string[]; unmatched: string[] } => {
  const position = new Map(outlineStatementIds.map((statementId, index) => [statementId, index]));
  const slides: PlanSceneDto[] = [];
  const others: PlanSceneDto[] = [];
  const usedStatements = new Set<string>();
  for (const scene of scenes) {
    if (scene.kind === 'slide' && scene.statementId) {
      slides.push(scene);
      usedStatements.add(scene.statementId);
    } else {
      others.push(scene);
    }
  }
  const missing = outlineStatementIds.filter((statementId) => !usedStatements.has(statementId));
  const unmatched = [...usedStatements].filter((statementId) => !position.has(statementId));
  const sorted = [...slides].sort((left, right) => {
    const leftIndex = position.get(left.statementId!) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = position.get(right.statementId!) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.sceneId.localeCompare(right.sceneId);
  });
  return { scenes: [...sorted, ...others], missing, unmatched };
};

/**
 * 场景计划里的互动场景内容（OMA-006 的互动/PBL 完整内容生成入口校验）。
 *
 * 互动场景的正文由已审核的正式互动定义给出；计划侧只允许「绑定一个已审核定义」，
 * 不允许计划自带 html/脚本。这里核对「计划里的互动场景集合」与「本版本已审核定义集合」一一对应，
 * 并把缺定义/多余定义的差异列出来，避免出现「计划说有互动、课堂却拿不到已审核定义」的静默空场景。
 */
export const assertPlanInteractionsReviewed = (
  scenes: readonly PlanSceneDto[],
  definitions: readonly FormalInteractionDefinitionDto[],
): void => {
  const planned = new Set(
    scenes.filter((scene) => scene.kind === 'interactive').map((scene) => scene.sceneId),
  );
  const reviewed = new Set(
    definitions.map((definition) => formalInteractionSceneId(definition.id)),
  );
  const missing = [...planned].filter((sceneId) => !reviewed.has(sceneId));
  if (missing.length > 0) {
    throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', {
      reason: 'interactive_definition_missing',
      missing,
    });
  }
};

/** 新场景编号：稳定、可预测前缀 + 随机段，绝不与既有场景重复。 */
export const planSceneId = (kind: string, seed: () => string): string => `scene_${kind}_${seed()}`;

export const planElementId = (kind: string, seed: () => string): string => `el_${kind}_${seed()}`;

/**
 * 局部重生成只替换目标场景的元素，其余场景逐字保留。
 * 目标场景不存在时按「无此场景」拒绝，不静默追加一个。
 */
export const replaceSceneElements = (
  scenes: readonly PlanSceneDto[],
  sceneId: string,
  elements: PlanElementDto[],
): PlanSceneDto[] => {
  if (!scenes.some((scene) => scene.sceneId === sceneId)) {
    throw new StudyError('NOT_FOUND', { reason: 'scene_not_in_plan', sceneId });
  }
  return scenes.map((scene) => (scene.sceneId === sceneId ? { ...scene, elements } : scene));
};

/** 复制场景得到一个新编号的副本，正文逐字保留但身份必须是新的。 */
export const duplicateScene = (
  scenes: readonly PlanSceneDto[],
  sceneId: string,
  nextId: () => string,
): { scenes: PlanSceneDto[]; copy: PlanSceneDto } => {
  const index = scenes.findIndex((scene) => scene.sceneId === sceneId);
  if (index < 0) throw new StudyError('NOT_FOUND', { reason: 'scene_not_in_plan', sceneId });
  const source = scenes[index]!;
  const copy: PlanSceneDto = {
    ...source,
    sceneId: nextId(),
    elements: source.elements.map((element) => ({ ...element, elementId: nextId() })),
  };
  const next = [...scenes];
  next.splice(index + 1, 0, copy);
  return { scenes: next, copy };
};

/** 删除场景：至少保留一个，空计划不能保存。 */
export const removeScene = (scenes: readonly PlanSceneDto[], sceneId: string): PlanSceneDto[] => {
  if (!scenes.some((scene) => scene.sceneId === sceneId)) {
    throw new StudyError('NOT_FOUND', { reason: 'scene_not_in_plan', sceneId });
  }
  const next = scenes.filter((scene) => scene.sceneId !== sceneId);
  if (next.length === 0) throw new StudyError('INVALID_ARGUMENT', { reason: 'plan_has_no_scenes' });
  return next;
};

/** 按给定顺序重排；顺序集合必须与现有场景完全一致，缺项或多项即拒绝。 */
export const reorderScenes = (
  scenes: readonly PlanSceneDto[],
  orderedIds: readonly string[],
): PlanSceneDto[] => {
  const byId = new Map(scenes.map((scene) => [scene.sceneId, scene]));
  if (orderedIds.length !== scenes.length || new Set(orderedIds).size !== orderedIds.length) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'reorder_set_mismatch' });
  }
  const next = orderedIds.map((sceneId) => byId.get(sceneId));
  if (next.some((scene) => scene === undefined)) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'reorder_set_mismatch' });
  }
  return next as PlanSceneDto[];
};

/** 计划可编辑的前提：基线版本仍是草案。已发布/撤回/被取代的版本不能被原地改写。 */ export const assertPlanEditable =
  (status: string): void => {
    if (status !== 'draft') {
      throw new StudyError('STEP_ALREADY_COMMITTED', { status, reason: 'plan_base_not_draft' });
    }
  };

/** 完整课件候选只在待核状态可处置；通过或拒绝后不能改判。 */
export const assertCoursewareDecidable = (status: string): void => {
  if (status !== 'pending') {
    throw new StudyError('STEP_ALREADY_COMMITTED', {
      status,
      reason: 'courseware_already_decided',
    });
  }
};

/**
 * 审核结论必须对**当前的**计划内容有效。
 *
 * 审核当时记录了计划基线（`planRevision`/`planDigest`），此后手工保存或候选应用改了内容，
 * 旧审核就不能再给新内容背书。判定同时比较摘要与 revision：
 * - 摘要一致 → 内容没变，即使 revision 因重存推进也仍然有效（避免误伤）；
 * - 摘要不一致 → 内容已变，旧审核失效，必须重新审核；
 * - 历史课程无计划（基线为 null）→ 只要求当前也没有计划，保持兼容。
 */
export const assertReviewMatchesPlan = (
  review: { decision: string; planRevision: number | null; planDigest: string | null },
  current: { revision: number; digest: string } | null,
): void => {
  if (current === null) {
    if (review.planDigest !== null) {
      throw new StudyError('VERSION_CONFLICT', { reason: 'review_plan_removed' });
    }
    return;
  }
  if (review.planDigest === null) {
    throw new StudyError('VERSION_CONFLICT', { reason: 'review_plan_missing' });
  }
  if (review.planDigest !== current.digest) {
    throw new StudyError('VERSION_CONFLICT', {
      reason: 'review_plan_changed',
      reviewedRevision: review.planRevision,
      currentRevision: current.revision,
    });
  }
};

/**
 * 发布前的计划复核：当前计划内容必须与审核当时的基线一致。
 *
 * 与审核入口共用同一份判定，避免出现「审核拦了、发布却放行」的口径分裂。
 */
export const assertPlanPublishable = (
  review: { decision: string; planRevision: number | null; planDigest: string | null } | null,
  current: { revision: number; digest: string } | null,
): void => {
  if (!review || review.decision !== 'approved') {
    throw new StudyError('CLASSROOM_LESSON_NOT_REVIEWED', {
      reason: 'lesson_version_not_approved',
    });
  }
  assertReviewMatchesPlan(review, current);
};

/**
 * 完整课件生成的提示词（OMA-006）。
 *
 * 只允许模型决定「讲哪些已选陈述、按什么顺序、每个场景怎么写」，不得新增事实或来源：
 * 陈述正文与其来源作为数据给出，模型只能引用已给出的 `statementId`/`questionId`。
 * 教师补充说明按数据处理，不作为新的事实来源。
 */
export const coursewarePrompt = (input: {
  subject: string;
  statements: Array<{ statementId: string; text: string; conditions: string }>;
  questions: Array<{ questionId: string; stem: string }>;
  instruction: string;
}): Array<{ role: 'system' | 'user'; content: string }> => {
  const statementLines = input.statements
    .map(
      (item) =>
        `- ${item.statementId}：${item.text}${item.conditions ? `（条件：${item.conditions}）` : ''}`,
    )
    .join('\n');
  const questionLines = input.questions
    .map((item) => `- ${item.questionId}：${item.stem}`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        '你是本地备考工作台的课件编排助手。只允许把下面给出的已审核陈述与题目编排成场景序列，' +
        '不得新增未经给出的事实，不得虚构来源或知识点，不得声称内容已核实。' +
        '幻灯片场景必须绑定一条已给出的陈述编号；测验场景必须绑定一道已给出的题目编号；' +
        '互动/PBL 场景不绑定陈述或题目。只返回 JSON：' +
        '{"scenes":[{"kind":"slide|quiz|interactive|pbl","title":标题,' +
        '"statementId":陈述编号或null,"questionId":题目编号或null,' +
        '"elements":[{"text":场景正文,"style":{"fontSize":24,"color":"#232323","bold":false,"italic":false,"align":"left"}}]}]}。',
    },
    {
      role: 'user',
      content:
        `科目：${input.subject}\n` +
        `可选陈述：\n${statementLines || '（无）'}\n` +
        `可选题目：\n${questionLines || '（无）'}\n` +
        '教师编排要求（按数据对待，不是新的事实来源）："""\n' +
        `${input.instruction}\n"""`,
    },
  ];
};
