/**
 * 固定审核课件（M0 真实课堂基线）。
 *
 * 这是**演示材料**：内容为编者按公开常识撰写、已在本仓库内登记来源与审核记录的
 * 一小段必修一「函数单调性」课件，用于在没有模型的情况下验证真实课堂链路。
 * 它不是正式考纲，也不是真题；M1 前需替换为真实科目单元与正式考纲
 * （见《开工任务清单》第 2 节）。
 *
 * 文档形状完全沿用 `@openmaic/dsl` 的 `Stage` / `Scene` / `SceneContent`，
 * 场景的来源绑定不放进 DSL 文档（生成的 JSON Schema 对这些定义关闭了
 * `additionalProperties`），而是写进本项目 `classroom_scene_sources` 侧表。
 */

import type {
  Action,
  InteractiveContent,
  QuizContent,
  Scene,
  SlideContent,
  Stage,
} from '@openmaic/dsl';
import { DEMO_FORMULA_FONT_FAMILY, DEMO_IMAGE_REF } from './demo-asset-refs';

/** 本项目课堂文档形状：与 `@openmaic/storage` 的 MaicDocument 结构一致。 */
export type LessonScene = Scene<Action, SlideContent | QuizContent | InteractiveContent>;
export interface ClassroomDocument {
  stage: Stage;
  scenes: LessonScene[];
  dslVersion?: string;
}

export const FIXED_LESSON_ID = 'lesson-demo-monotonicity-1';
export const FIXED_STAGE_ID = 'stage-demo-monotonicity-1';

export const SCENE_SLIDE_ID = 'scene-slide-intro';
export const SCENE_QUIZ_ID = 'scene-quiz-single';
export const SCENE_INTERACTIVE_ID = 'scene-interactive-parameter';

/**
 * 测验题在 DSL 文档里的稳定键。项目内的真实题目 ID 由来源侧表绑定，
 * 文档本身不含项目相关取值，因此审核文档在任何项目下都是同一份、同一指纹。
 */
export const FIXED_QUIZ_QUESTION_KEY = 'demo-q-single-1';

/** 材料来源登记：文本由本文件提供，位置可定位到仓库路径。 */
export const FIXED_MATERIAL = {
  displayName: '演示材料：函数单调性（必修一片段）.md',
  materialType: 'md' as const,
  readableLocation: 'apps/learning/lib/classroom/reviewed-lesson.ts:FIXED_MATERIAL',
  /** 段落 S002 是概念依据，S003 是方法依据；provisioning 按内容匹配 segmentId。 */
  rawText: [
    '# 演示材料：函数的单调性（非正式考纲）',
    '',
    '函数的单调性：设函数 f(x) 的定义域为 I，如果对于定义域 I 内某个区间 D 上的任意两个自变量的值 x1、x2，',
    '当 x1 < x2 时，都有 f(x1) < f(x2)，那么就说函数 f(x) 在区间 D 上是增函数。',
    '',
    '判断单调性的基本步骤是取值、作差、变形、定号、下结论。',
    '',
    '减函数把上面的不等号方向反过来：当 x1 < x2 时都有 f(x1) > f(x2)。',
  ].join('\n'),
};

export const FIXED_KNOWLEDGE = {
  name: '函数单调性（增函数）的定义',
  concept: '在区间 D 内任取 x1 < x2，若都有 f(x1) < f(x2)，则 f(x) 在 D 上是增函数',
  conditions: '自变量必须取自同一个区间 D 内的任意两个值',
  acceptance: '能按定义判断给定函数在给定区间上的单调性',
  priority: 'high' as const,
  /** 概念依据所在段落（按规范化后的段落文本匹配，不写死序号）。 */
  conceptMarker: '那么就说函数 f(x) 在区间 D 上是增函数',
  methodMarker: '判断单调性的基本步骤是取值、作差、变形、定号、下结论',
};

export const FIXED_QUESTION = {
  stem: '按定义，判断 f(x) 在区间 D 上为增函数时，对 D 内任意两个自变量 x1、x2（x1 < x2）应满足下列哪一项？',
  answer: 'B',
  solution: '定义要求 x1 < x2 时都有 f(x1) < f(x2)，即较小的自变量对应较小的函数值。',
  options: [
    { label: 'A. f(x1) > f(x2)', value: 'A' },
    { label: 'B. f(x1) < f(x2)', value: 'B' },
    { label: 'C. f(x1) = f(x2)', value: 'C' },
    { label: 'D. 只需存在一对 x1 < x2 使 f(x1) < f(x2)', value: 'D' },
  ],
};

export const FIXED_REVIEW = {
  reviewedBy: '内置演示课件（编者按公开定义撰写并在仓库内登记，非正式考纲）',
  reviewNote:
    '演示材料：仅用于验证真实课堂链路（文档、渲染、来源绑定、作答持久化）。' +
    '内容不是考试真题，也不作为正式教学单元；M1 前替换为真实科目材料。',
};

const theme = {
  backgroundColor: '#f7f3e9',
  themeColors: ['#1f6f5c', '#b45309', '#1e3a8a', '#333333'],
  fontColor: '#2b2b2b',
  fontName: 'Microsoft YaHei',
};

const text = (
  id: string,
  top: number,
  height: number,
  content: string,
  width = 800,
  left = 100,
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
  defaultColor: '#2b2b2b',
  lineHeight: 1.5,
});

/** 互动场景：受控参数实验，运行在隔离 iframe 内（无 preload、无 Node）。 */
const interactiveHtml = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>参数实验：a 对 f(x)=ax 单调性的影响</title>
<style>
  body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;margin:16px;color:#2b2b2b;background:#fbf8f1}
  h1{font-size:16px;margin:0 0 8px}
  p{font-size:13px;margin:6px 0}
  output{font-variant-numeric:tabular-nums;font-weight:600}
  canvas{border:1px solid #d8cfa8;border-radius:6px;background:#fff;display:block}
</style></head>
<body>
<h1>参数实验（组件自报，低信任）</h1>
<p>拖动滑块改变 a，观察 f(x)=a·x 的增减方向。</p>
<p>a = <output id="aOut">1.0</output>，斜率方向 = <output id="dir">递增</output></p>
<canvas id="plot" width="360" height="200"></canvas>
<label for="a">a 取值</label>
<input id="a" type="range" min="-3" max="3" step="0.1" value="1">
<script>
  const input = document.getElementById('a');
  const aOut = document.getElementById('aOut');
  const dir = document.getElementById('dir');
  const plot = document.getElementById('plot');
  const ctx = plot.getContext('2d');
  function draw(a) {
    ctx.clearRect(0, 0, plot.width, plot.height);
    ctx.strokeStyle = '#888';
    ctx.beginPath(); ctx.moveTo(0, 100); ctx.lineTo(360, 100); ctx.moveTo(180, 0); ctx.lineTo(180, 200); ctx.stroke();
    ctx.strokeStyle = a >= 0 ? '#1f6f5c' : '#b45309';
    ctx.beginPath();
    ctx.moveTo(20, 100 + a * 16);
    ctx.lineTo(340, 100 - a * 16 * 3);
    ctx.stroke();
    aOut.textContent = a.toFixed(1);
    dir.textContent = a > 0 ? '递增' : a < 0 ? '递减' : '恒为 0';
    // 组件自报自己的隔离环境：沙箱内不应有原生桥或 Node。
    window.parent && window.parent.postMessage({
      type: 'widget-observation',
      a: a,
      direction: dir.textContent,
      nativeBridge: typeof window.sewNative,
      nodeRequire: typeof window.require,
    }, '*');
  }
  input.addEventListener('input', () => draw(Number(input.value)));
  draw(Number(input.value));
</script>
</body>
</html>`;

/** 文档时间戳固定：同一份审核课件在任何项目、任何时刻都得到同一指纹。 */
const FIXED_CREATED_AT = Date.UTC(2026, 9, 3, 9, 0, 0);

/**
 * 构造审核课件文档。返回的文档包含判分答案，只用于服务端登记与指纹计算；
 * 交给渲染端前必须经 `stripQuizAnswers` 去掉答案。
 */
export const buildFixedLessonDocument = (): ClassroomDocument => {
  const createdAt = FIXED_CREATED_AT;
  const stage = {
    id: FIXED_STAGE_ID,
    name: '函数单调性（演示课件）',
    description: '演示课件：一张幻灯片、一道单选测验、一个参数实验互动',
    createdAt,
    updatedAt: createdAt,
    languageDirective: 'zh-CN',
  };

  const slideScene = {
    id: SCENE_SLIDE_ID,
    stageId: FIXED_STAGE_ID,
    title: '增函数的定义',
    order: 0,
    createdAt,
    updatedAt: createdAt,
    type: 'slide' as const,
    content: {
      type: 'slide' as const,
      schemaVersion: 1,
      canvas: {
        id: 'slide-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme,
        elements: [
          text('slide-1-title', 80, 90, '<h1 style="font-size:40px">增函数的定义</h1>'),
          text(
            'slide-1-body',
            210,
            150,
            `<p style="font-size:26px">在区间 D 内任取 ${'x'}<sub>1</sub> &lt; ${'x'}<sub>2</sub>，</p>` +
              '<p style="font-size:26px">若都有 f(x<sub>1</sub>) &lt; f(x<sub>2</sub>)，则 f(x) 在 D 上是增函数。</p>',
            500,
          ),
          text(
            'slide-1-method',
            380,
            70,
            '<p style="font-size:20px;color:#1f6f5c">步骤：取值 → 作差 → 变形 → 定号 → 下结论</p>',
            500,
          ),
          {
            id: 'slide-1-demo-image',
            left: 610,
            top: 190,
            width: 270,
            height: 169,
            rotate: 0,
            type: 'image' as const,
            fixedRatio: true,
            src: DEMO_IMAGE_REF,
            imageType: 'pageFigure' as const,
            radius: 8,
          },
          {
            id: 'slide-1-formula-font-proof',
            left: 610,
            top: 390,
            width: 300,
            height: 60,
            rotate: 0,
            type: 'text' as const,
            content: `<p style="font-family:'${DEMO_FORMULA_FONT_FAMILY}';font-size:30px;color:#1f6f5c">f(x₁) &lt; f(x₂)</p>`,
            defaultFontName: DEMO_FORMULA_FONT_FAMILY,
            defaultColor: '#1f6f5c',
            lineHeight: 1.3,
          },
          text(
            'slide-1-source',
            500,
            60,
            '<p style="font-size:14px;color:#6b6b6b">演示材料，非正式考纲 · 来源见课件登记</p>',
          ),
        ],
      },
    },
  };

  const quizScene = {
    id: SCENE_QUIZ_ID,
    stageId: FIXED_STAGE_ID,
    title: '独立测验：定义判断',
    order: 1,
    createdAt,
    updatedAt: createdAt,
    type: 'quiz' as const,
    content: {
      type: 'quiz' as const,
      questions: [
        {
          id: FIXED_QUIZ_QUESTION_KEY,
          type: 'single' as const,
          question: FIXED_QUESTION.stem,
          options: FIXED_QUESTION.options.map((option) => ({
            label: option.label,
            value: option.value,
          })),
          answer: [FIXED_QUESTION.answer],
          analysis: FIXED_QUESTION.solution,
        },
      ],
    },
  };

  const interactiveScene = {
    id: SCENE_INTERACTIVE_ID,
    stageId: FIXED_STAGE_ID,
    title: '参数实验：a 决定增减方向',
    order: 2,
    createdAt,
    updatedAt: createdAt,
    type: 'interactive' as const,
    content: {
      type: 'interactive' as const,
      html: interactiveHtml,
      widgetType: 'simulation' as const,
      widgetConfig: { type: 'simulation' as const, parameter: 'a', min: -3, max: 3 },
    },
  };

  return {
    stage,
    scenes: [slideScene, quizScene, interactiveScene] satisfies LessonScene[],
    dslVersion: '0.3.0',
  };
};

/**
 * 审核登记：允许写入本项目的课堂文档身份。
 *
 * 渲染端 PUT 过来的内容必须与此完全一致（同指纹），否则视为未审核内容。
 * 指纹在建模块时由 `@sew/study-domain` 的稳定序列化算出，不写死常量，
 * 避免课件文本改动后指纹与内容脱节。
 */
export const REVIEWED_FIXED_LESSON = {
  lessonId: FIXED_LESSON_ID,
  stageId: FIXED_STAGE_ID,
  sceneIds: [SCENE_SLIDE_ID, SCENE_QUIZ_ID, SCENE_INTERACTIVE_ID] as string[],
  quizQuestionKey: FIXED_QUIZ_QUESTION_KEY,
  document: buildFixedLessonDocument(),
  reviewedBy: FIXED_REVIEW.reviewedBy,
  reviewNote: FIXED_REVIEW.reviewNote,
};
