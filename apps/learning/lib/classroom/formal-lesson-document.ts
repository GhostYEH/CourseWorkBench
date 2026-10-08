/**
 * 正式课件文档装配（LESSON-02 的文档生成部分）。
 *
 * 输入只有已冻结的证据包与课程版本：每条幻灯片场景对应一条冻结陈述，
 * 场景文本取陈述正文与适用条件，来源定位写进页面本身，教师与学生都能看到「这句话出自哪一段」。
 * 这里不接模型：模型产物必须先经人工审核成为证据包里的陈述，才能进入正式课件文档，
 * 因此同一份证据包在任何项目、任何时刻都装配出同一份文档与同一个指纹。
 *
 * 测验只取冻结快照中已登记的题型与评分规则；历史包缺少快照时逐题报告跳过。
 */

import type {
  InteractiveContent,
  PBLContent,
  QuizContent,
  Scene,
  SlideContent,
  Stage,
  Action,
} from '@openmaic/dsl';
import { DSL_VERSION } from '@openmaic/dsl';
import { formalInteractionSceneId, pblProjectSceneId } from '@sew/study-domain';
import type {
  EvidenceBundleDto,
  FormalInteractionDefinitionDto,
  PblFrozenDto,
} from '@sew/study-contracts';
import type { ClassroomDocument, LessonScene } from './reviewed-lesson';
import { pblSceneContent } from './pbl-scene-content';

/** 场景编号上限：证据包异常大时按顺序保留前面的陈述，其余显式列为未生成。 */
export const FORMAL_SCENE_LIMIT = 24;

export const formalStageId = (lessonId: string, lessonVersion: number): string =>
  `stage_formal_${lessonId}_v${lessonVersion}`;

export const formalStatementSceneId = (statementId: string): string => `scene_slide_${statementId}`;

export const formalQuestionSceneId = (questionId: string): string => `scene_quiz_${questionId}`;

export const FORMAL_QUESTION_NOTE_SCENE_ID = 'scene_slide_question_note';

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 单条最长展示文本：超出部分标注截断，不把整段来源原文塞进画布。 */
const clamp = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}…（已截断 ${value.length - limit} 字）` : value;

const theme = {
  backgroundColor: '#f4f6fb',
  themeColors: ['#1e3a8a', '#0f766e', '#b45309', '#333333'],
  fontColor: '#232323',
  fontName: 'Microsoft YaHei',
};

const textElement = (
  id: string,
  top: number,
  height: number,
  content: string,
  width = 800,
  left = 90,
) => ({
  id,
  left,
  top,
  width,
  height,
  rotate: 0,
  type: 'text' as const,
  content,
  defaultFontName: 'Microsoft YaHei',
  defaultColor: '#232323',
  lineHeight: 1.5,
});

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

export interface FormalLessonScene {
  sceneId: string;
  sceneType: 'slide' | 'quiz' | 'interactive' | 'pbl';
  questionId: string | null;
  title: string;
  knowledgeIds: string[];
  /** 该场景依据的证据包陈述编号；题目说明场景没有单条陈述。 */
  statementId: string | null;
  statementIds?: string[];
}

export interface FormalLessonSkipped {
  kind: 'statement' | 'question';
  id: string;
  reason: string;
}

export interface FormalLessonPlan {
  stageId: string;
  dslVersion: string;
  document: ClassroomDocument;
  scenes: FormalLessonScene[];
  skipped: FormalLessonSkipped[];
}

/**
 * 由证据包装配正式课件文档。
 *
 * 时间戳取证据包的冻结时刻，保证「同一份冻结事实 → 同一份文档 → 同一个指纹」；
 * 冻结时刻解析失败时退回 0 而不是当前时间，避免同一证据包每次装配都产生新指纹。
 */
export const buildFormalLessonDocument = (input: {
  bundle: EvidenceBundleDto;
  bundleDigest: string;
  lessonId: string;
  lessonVersion: number;
  title: string;
  frozenAt: string;
  statementIds?: string[];
  questionIds?: string[];
  interactions?: FormalInteractionDefinitionDto[];
  pblDefinition?: PblFrozenDto | null;
}): FormalLessonPlan => {
  const parsed = Date.parse(input.frozenAt);
  const at = Number.isFinite(parsed) ? parsed : 0;
  const stageId = formalStageId(input.lessonId, input.lessonVersion);
  const scenes: FormalLessonScene[] = [];
  const dslScenes: Array<
    Scene<Action, SlideContent | QuizContent | InteractiveContent | PBLContent>
  > = [];
  const skipped: FormalLessonSkipped[] = [];
  const contentLimit = FORMAL_SCENE_LIMIT - (input.interactions?.length ?? 0);
  const pblDefinition = input.pblDefinition ?? null;

  const statements = input.bundle.statements.filter(
    (item) => !input.statementIds || input.statementIds.includes(item.statementId),
  );
  const questions = input.bundle.questions.filter(
    (item) => !input.questionIds || input.questionIds.includes(item.questionId),
  );
  statements.forEach((statement, index) => {
    if (dslScenes.length >= contentLimit) {
      skipped.push({
        kind: 'statement',
        id: statement.statementId,
        reason: `场景数量达到上限 ${FORMAL_SCENE_LIMIT}，本条陈述未进入课件`,
      });
      return;
    }
    const sceneId = formalStatementSceneId(statement.statementId);
    const sources = statement.evidence
      .map((ref) => `${ref.materialId}#${ref.segmentId}@r${ref.revision}（${ref.use}）`)
      .join('、');
    const elements: unknown[] = [
      textElement(
        `${sceneId}-title`,
        70,
        90,
        `<h1 style="font-size:36px">陈述 ${index + 1}：${escapeText(clamp(statement.text, 60))}</h1>`,
      ),
      textElement(
        `${sceneId}-body`,
        190,
        170,
        `<p style="font-size:24px">${escapeText(clamp(statement.text, 600))}</p>`,
      ),
    ];
    if (statement.conditions) {
      elements.push(
        textElement(
          `${sceneId}-conditions`,
          360,
          90,
          `<p style="font-size:20px;color:#0f766e">适用条件：${escapeText(clamp(statement.conditions, 300))}</p>`,
        ),
      );
    }
    elements.push(
      textElement(
        `${sceneId}-knowledge`,
        450,
        50,
        `<p style="font-size:16px">知识点 ${escapeText(statement.knowledgeId)}</p>`,
      ),
      textElement(
        `${sceneId}-source`,
        500,
        70,
        `<p style="font-size:14px;color:#5a5a5a">来源：${escapeText(clamp(sources, 420))}</p>`,
      ),
    );

    dslScenes.push(
      slideScene({
        id: sceneId,
        stageId,
        order: dslScenes.length,
        title: `陈述 ${index + 1}`,
        at,
        elements,
      }),
    );
    scenes.push({
      sceneId,
      sceneType: 'slide',
      title: `陈述 ${index + 1}`,
      knowledgeIds: [statement.knowledgeId],
      statementId: statement.statementId,
      questionId: null,
    });
  });

  for (const question of questions) {
    const snapshot = question.snapshot;
    const assessment = snapshot?.assessment;
    if (!snapshot || !assessment) {
      skipped.push({
        kind: 'question',
        id: question.questionId,
        reason: '冻结题目未登记题型与评分规则，不生成测验场景（ANSWER-01）',
      });
      continue;
    }
    if (dslScenes.length >= contentLimit) {
      skipped.push({
        kind: 'question',
        id: question.questionId,
        reason: `场景数量达到上限 ${FORMAL_SCENE_LIMIT}，本题未进入课件`,
      });
      continue;
    }
    const sceneId = formalQuestionSceneId(question.questionId);
    dslScenes.push({
      id: sceneId,
      stageId,
      title: `独立测验 ${question.questionId}`,
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
      sceneId,
      sceneType: 'quiz',
      title: `独立测验 ${question.questionId}`,
      knowledgeIds: question.knowledgeIds,
      questionId: question.questionId,
      statementId: null,
    });
  }

  for (const definition of input.interactions ?? []) {
    if (dslScenes.length >= FORMAL_SCENE_LIMIT) break;
    const sceneId = formalInteractionSceneId(definition.id);
    const knowledgeIds = [
      ...new Set(
        statements
          .filter((s) => definition.statementIds.includes(s.statementId))
          .map((s) => s.knowledgeId),
      ),
    ];
    dslScenes.push({
      id: sceneId,
      stageId,
      title: definition.title,
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
      sceneId,
      sceneType: 'interactive',
      title: definition.title,
      knowledgeIds,
      statementId: null,
      questionId: null,
    });
  }

  if (pblDefinition && dslScenes.length < FORMAL_SCENE_LIMIT) {
    const statementIds = [...pblDefinition.definition.statementIds];
    const knowledgeIds = [
      ...new Set(
        statements
          .filter((item) => statementIds.includes(item.statementId))
          .map((item) => item.knowledgeId),
      ),
    ];
    if (
      knowledgeIds.length === 0 ||
      statementIds.some((id) => !statements.some((statement) => statement.statementId === id))
    ) {
      skipped.push({
        kind: 'statement',
        id: pblDefinition.definition.id,
        reason: 'PBL 定义引用的陈述不在本版本冻结证据包',
      });
    } else {
      const sceneId = pblProjectSceneId(pblDefinition.definition.id);
      dslScenes.push({
        id: sceneId,
        stageId,
        title: pblDefinition.definition.title,
        order: dslScenes.length,
        createdAt: at,
        updatedAt: at,
        type: 'pbl',
        content: pblSceneContent(pblDefinition, input.frozenAt),
      });
      scenes.push({
        sceneId,
        sceneType: 'pbl',
        title: pblDefinition.definition.title,
        knowledgeIds,
        statementId: null,
        statementIds,
        questionId: null,
      });
    }
  } else if (pblDefinition) {
    skipped.push({
      kind: 'statement',
      id: pblDefinition.definition.id,
      reason: `场景数量达到上限 ${FORMAL_SCENE_LIMIT}，PBL 项目未进入课件`,
    });
  }

  const stage: Stage = {
    id: stageId,
    name: input.title,
    description: `正式课件 · 证据包 ${input.bundleDigest.slice(0, 12)} · 计划 v${input.bundle.planVersion} · ${statements.length} 条陈述`,
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
