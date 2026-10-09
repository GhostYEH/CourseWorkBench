/**
 * 场景计划 → 正式课件文档（LESSON-02 / OMA-006、OMA-021、OMA-022）。
 *
 * 计划在确定性装配（`buildFormalLessonDocument`）之上补两层可编辑能力：
 * - 场景集合与顺序由计划决定（增删/排序/复制/局部重生成），不是「证据包里有多少条陈述就多少场景」；
 * - 幻灯片场景的元素（正文富文本、字号/颜色/加粗/对齐、位置尺寸）由计划给出。
 *
 * 同一份（证据包 + 计划）在任何时刻都装配出同一份文档与同一个指纹：时间戳取证据包冻结时刻，
 * 元素顺序与文本逐字来自计划，不掺入当前时间或随机值。
 *
 * 场景集合以计划为准，显式删除的内容不自动加回；测验取冻结题目快照，互动按稳定身份查
 * 审核定义，知识点由服务端从绑定对象沿用。互动/PBL 的完整内容生成仍属后续范围。
 */

import type {
  Action,
  InteractiveContent,
  PBLContent,
  QuizContent,
  Scene,
  SlideContent,
  Stage,
} from '@openmaic/dsl';
import { DSL_VERSION } from '@openmaic/dsl';
import { StudyError } from '@sew/study-contracts';
import { formalInteractionSceneId, pblProjectSceneId } from '@sew/study-domain';
import type {
  EvidenceBundleDto,
  FormalInteractionDefinitionDto,
  PblFrozenDto,
  PlanElementDto,
  PlanSceneDto,
  ScenePlanDto,
} from '@sew/study-contracts';
import type { ClassroomDocument, LessonScene } from './reviewed-lesson';
import { FORMAL_SCENE_LIMIT, formalStageId } from './formal-lesson-document';
import { escapePlanText, renderPlanRichText } from './plan-rich-text';
import { pblSceneContent } from './pbl-scene-content';

const theme = {
  backgroundColor: '#f4f6fb',
  themeColors: ['#1e3a8a', '#0f766e', '#b45309', '#333333'],
  fontColor: '#232323',
  fontName: 'Microsoft YaHei',
};

const ALIGN_TO_JUSTIFY: Record<PlanElementDto['style']['align'], 'left' | 'center' | 'right'> = {
  left: 'left',
  center: 'center',
  right: 'right',
};

/** 计划元素 → DSL 文本/图片元素。位置尺寸、旋转与样式来自计划。 */
const planElementToDsl = (element: PlanElementDto) => {
  if (element.kind === 'image') {
    return {
      id: element.elementId,
      left: element.left,
      top: element.top,
      width: element.width,
      height: element.height,
      rotate: element.rotation ?? 0,
      type: 'image' as const,
      fixedRatio: true,
      src: element.assetRef ?? '',
      imageType: 'pageFigure' as const,
      radius: 8,
    };
  }
  const { fontSize, color, bold, italic, align } = element.style;
  const inner = renderPlanRichText(element.text);
  const style = [
    `font-size:${fontSize}px`,
    `color:${color}`,
    bold ? 'font-weight:700' : 'font-weight:400',
    italic ? 'font-style:italic' : 'font-style:normal',
    `text-align:${ALIGN_TO_JUSTIFY[align]}`,
  ].join(';');
  return {
    id: element.elementId,
    left: element.left,
    top: element.top,
    width: element.width,
    height: element.height,
    rotate: element.rotation ?? 0,
    type: 'text' as const,
    content: `<p style="${style}">${inner}</p>`,
    defaultFontName: 'Microsoft YaHei',
    defaultColor: color,
    lineHeight: 1.5,
  };
};

const slideScene = (input: {
  id: string;
  stageId: string;
  order: number;
  title: string;
  at: number;
  elements: unknown[];
}): Scene<Action, SlideContent> => ({
  id: input.id,
  stageId: input.stageId,
  title: input.title,
  order: input.order,
  createdAt: input.at,
  updatedAt: input.at,
  type: 'slide' as const,
  content: {
    type: 'slide' as const,
    schemaVersion: 1,
    canvas: {
      id: `${input.id}-canvas`,
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme,
      elements: input.elements as SlideContent['canvas']['elements'],
    },
  },
});

/** 计划装配可产出的四类场景内容：幻灯片、测验、互动与 PBL 骨架。 */
type PlannedSceneContent = SlideContent | QuizContent | InteractiveContent | PBLContent;

export interface PlannedLessonScene {
  sceneId: string;
  sceneType: PlanSceneDto['kind'];
  questionId: string | null;
  title: string;
  knowledgeIds: string[];
  statementId: string | null;
  /** PBL source statements derived from this version's frozen definition. */
  statementIds?: string[];
}

export interface PlannedLessonSkipped {
  kind: 'scene';
  id: string;
  reason: string;
}

export interface PlannedLessonDocument {
  stageId: string;
  dslVersion: string;
  document: ClassroomDocument;
  scenes: PlannedLessonScene[];
  skipped: PlannedLessonSkipped[];
}

/**
 * 由证据包 + 场景计划装配正式课件文档。
 *
 * 计划里的场景顺序就是文档顺序；每个场景的知识点由服务端从绑定的陈述/题目/互动定义沿用，
 * 与 `assertPlanGrounded` 的口径一致。计划超出上限时按顺序保留前面的场景，其余显式列为未生成。
 */
export const buildPlannedLessonDocument = (input: {
  bundle: EvidenceBundleDto;
  bundleDigest: string;
  plan: ScenePlanDto;
  lessonId: string;
  lessonVersion: number;
  title: string;
  frozenAt: string;
  interactions?: FormalInteractionDefinitionDto[];
  pblDefinition?: PblFrozenDto | null;
}): PlannedLessonDocument => {
  const parsed = Date.parse(input.frozenAt);
  const at = Number.isFinite(parsed) ? parsed : 0;
  const stageId = formalStageId(input.lessonId, input.lessonVersion);
  const statements = new Map(input.bundle.statements.map((item) => [item.statementId, item]));
  const questions = new Map(input.bundle.questions.map((item) => [item.questionId, item]));
  const definitions = new Map(
    (input.interactions ?? []).map((item) => [formalInteractionSceneId(item.id), item]),
  );
  const pblDefinition = input.pblDefinition ?? null;
  const pblSceneId = pblDefinition ? pblProjectSceneId(pblDefinition.definition.id) : null;

  const scenes: PlannedLessonScene[] = [];
  const dslScenes: Array<Scene<Action, PlannedSceneContent>> = [];
  const skipped: PlannedLessonSkipped[] = [];

  input.plan.scenes.forEach((scene) => {
    if (dslScenes.length >= FORMAL_SCENE_LIMIT) {
      skipped.push({
        kind: 'scene',
        id: scene.sceneId,
        reason: `场景数量达到上限 ${FORMAL_SCENE_LIMIT}，本场景未进入课件`,
      });
      return;
    }
    if (scene.kind === 'slide') {
      const statement = scene.statementId ? statements.get(scene.statementId) : undefined;
      if (!statement) {
        skipped.push({ kind: 'scene', id: scene.sceneId, reason: '绑定的陈述不在冻结证据包内' });
        return;
      }
      const elements =
        scene.elements.length > 0
          ? scene.elements
              .map((element, index) => ({ element, index }))
              .sort(
                (left, right) =>
                  (left.element.layerOrder ?? left.index) -
                  (right.element.layerOrder ?? right.index),
              )
              .map(({ element }) => planElementToDsl(element))
          : [
              {
                id: `${scene.sceneId}-body`,
                left: 90,
                top: 190,
                width: 800,
                height: 170,
                rotate: 0,
                type: 'text' as const,
                content: `<p style="font-size:24px">${escapePlanText(statement.text).replace(/\r?\n/g, '<br>')}</p>`,
                defaultFontName: 'Microsoft YaHei',
                defaultColor: '#232323',
                lineHeight: 1.5,
              },
            ];
      dslScenes.push(
        slideScene({
          id: scene.sceneId,
          stageId,
          order: dslScenes.length,
          title: scene.title,
          at,
          elements,
        }),
      );
      scenes.push({
        sceneId: scene.sceneId,
        sceneType: 'slide',
        title: scene.title,
        knowledgeIds: [statement.knowledgeId],
        statementId: statement.statementId,
        questionId: null,
      });
      return;
    }

    if (scene.kind === 'quiz') {
      const question = scene.questionId ? questions.get(scene.questionId) : undefined;
      const snapshot = question?.snapshot;
      const assessment = snapshot?.assessment;
      if (!question || !snapshot || !assessment) {
        skipped.push({
          kind: 'scene',
          id: scene.sceneId,
          reason: '绑定的题目缺少冻结题型与评分规则',
        });
        return;
      }
      dslScenes.push({
        id: scene.sceneId,
        stageId,
        title: scene.title,
        order: dslScenes.length,
        createdAt: at,
        updatedAt: at,
        type: 'quiz',
        content: {
          type: 'quiz',
          questions: [
            {
              id: question.questionId,
              type: assessment.type,
              question: snapshot.stem,
              ...(assessment.type === 'short_answer' ? {} : { options: assessment.options }),
              answer: assessment.correctAnswers,
              analysis: snapshot.solution,
              points: assessment.maxScore,
            },
          ],
        },
      });
      scenes.push({
        sceneId: scene.sceneId,
        sceneType: 'quiz',
        title: scene.title,
        knowledgeIds: [...question.knowledgeIds],
        statementId: null,
        questionId: question.questionId,
      });
      return;
    }

    if (scene.kind === 'interactive') {
      const definition = definitions.get(scene.sceneId);
      // 互动场景必须绑定**本版本已审核**的正式互动定义：定义缺失时这是「漏装配」，
      // 明确列为未生成（而不是塞一段占位 HTML 冒充互动内容），界面据此提示补定义或删场景。
      if (!definition) {
        skipped.push({
          kind: 'scene',
          id: scene.sceneId,
          reason: '互动场景缺少本版本已审核的正式互动定义，未进入课件',
        });
        return;
      }
      const knowledgeIds = [
        ...new Set(
          definition.statementIds
            .map((statementId) => statements.get(statementId)?.knowledgeId)
            .filter((value): value is string => Boolean(value)),
        ),
      ];
      dslScenes.push({
        id: scene.sceneId,
        stageId,
        title: scene.title,
        order: dslScenes.length,
        createdAt: at,
        updatedAt: at,
        type: 'interactive',
        content: {
          type: 'interactive',
          html: '<!doctype html><html><body><p>本人互动由课堂宿主提供。来源与参数范围经人工审核。</p></body></html>',
        },
      });
      scenes.push({
        sceneId: scene.sceneId,
        sceneType: 'interactive',
        title: scene.title,
        knowledgeIds,
        statementId: null,
        questionId: null,
      });
      return;
    }

    // 历史计划里的自由 PBL 场景只能显式跳过；当前可授课场景必须绑定本版本冻结定义。
    if (!pblDefinition) {
      skipped.push({
        kind: 'scene',
        id: scene.sceneId,
        reason: 'PBL 场景缺少本版本已审核并冻结的定义，未进入课件',
      });
      return;
    }
    if (scene.sceneId !== pblSceneId) {
      throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', {
        reason: 'pbl_scene_definition_mismatch',
        sceneId: scene.sceneId,
      });
    }
    const statementIds = [...pblDefinition.definition.statementIds];
    const knowledgeIds = [
      ...new Set(
        statementIds
          .map((id) => statements.get(id)?.knowledgeId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (knowledgeIds.length === 0 || statementIds.some((id) => !statements.has(id))) {
      skipped.push({
        kind: 'scene',
        id: scene.sceneId,
        reason: 'PBL 定义引用的陈述不在冻结证据包，未进入课件',
      });
      return;
    }
    dslScenes.push({
      id: scene.sceneId,
      stageId,
      title: scene.title,
      order: dslScenes.length,
      createdAt: at,
      updatedAt: at,
      type: 'pbl',
      content: pblSceneContent(pblDefinition, input.frozenAt),
    });
    scenes.push({
      sceneId: scene.sceneId,
      sceneType: 'pbl',
      title: scene.title,
      knowledgeIds,
      statementIds,
      statementId: null,
      questionId: null,
    });
  });

  const stage: Stage = {
    id: stageId,
    name: input.title,
    description: `正式课件 · 证据包 ${input.bundleDigest.slice(0, 12)} · 计划 v${input.plan.revision} · ${scenes.length} 个场景`,
    createdAt: at,
    updatedAt: at,
    languageDirective: 'zh-CN',
  };

  return {
    stageId,
    dslVersion: DSL_VERSION,
    document: { stage, scenes: dslScenes as LessonScene[], dslVersion: DSL_VERSION },
    scenes,
    skipped,
  };
};
