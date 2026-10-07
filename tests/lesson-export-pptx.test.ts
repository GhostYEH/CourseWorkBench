import { describe, expect, it } from 'vitest';
import type { PlanElementDto, PlanSceneDto } from '@sew/study-contracts';
import {
  EMU_PER_PIXEL,
  PPTX_EXPORT_FORMAT,
  PPTX_EXPORT_VERSION,
  PPTX_MODEL_KEYS,
  PPTX_SLIDE_SIZES,
  assertPptxDeckEditable,
  assertPptxDeckSchemaClosed,
  buildPptxDeck,
  classifyMediaReference,
  collectPptxAssetRefs,
  isPortableMediaReference,
  pptxCentipointsFromPixels,
  pptxDeckDigest,
  pptxDeckEditabilityViolations,
  pptxDeckSchemaViolations,
  richTextToPlainText,
  richTextToRuns,
  splitFormulaSegments,
  type PptxDeck,
  type PptxDeckIdentity,
  type PptxMediaFact,
  type PptxPictureShape,
} from '../packages/study-domain/src/lesson-export-pptx';
import { scenePlanDigest } from '../packages/study-domain/src/scene-plan';

const identity = (planDigest: string | null = null): PptxDeckIdentity => ({
  projectId: 'proj_pptx',
  lessonId: 'lesson_1',
  lessonVersion: 1,
  bundleId: 'bundle_1',
  title: '可编辑导出测试课件',
  stageId: 'stage_formal_lesson_1_v1',
  dslVersion: '0.11.2',
  documentDigest: 'a'.repeat(64),
  exportedDocumentDigest: 'b'.repeat(64),
  planDigest,
});

const textElement = (overrides: Partial<PlanElementDto> = {}): PlanElementDto => ({
  elementId: 'el_text_1',
  kind: 'text',
  text: '物体质量 **m** 与加速度 a 满足 $F = m a$',
  assetRef: null,
  left: 100,
  top: 200,
  width: 600,
  height: 120,
  style: { fontSize: 24, color: '#232323', bold: false, italic: false, align: 'left' },
  ...overrides,
});

const imageElement = (
  assetRef: string | null,
  overrides: Partial<PlanElementDto> = {},
): PlanElementDto => ({
  elementId: 'el_image_1',
  kind: 'image',
  text: '',
  assetRef,
  left: 700,
  top: 200,
  width: 250,
  height: 180,
  style: { fontSize: 12, color: '#232323', bold: false, italic: false, align: 'left' },
  ...overrides,
});

const slideScene = (
  elements: PlanElementDto[],
  overrides: Partial<PlanSceneDto> = {},
): PlanSceneDto => ({
  sceneId: 'scene_slide_1',
  kind: 'slide',
  title: '牛顿第二定律',
  statementId: 'st_1',
  questionId: null,
  knowledgeIds: ['kp_1'],
  elements,
  note: '本场景讲解 F=ma 的适用条件',
  ...overrides,
});

const media = new Map<string, PptxMediaFact>([
  [
    'demo-image',
    {
      reference: 'assets/asset-0.png',
      mediaType: 'image/png',
      sha256: 'c'.repeat(64),
      byteLength: 2048,
    },
  ],
  [
    'inline-image',
    {
      reference: 'data:image/png;base64,AAAA',
      mediaType: 'image/png',
      sha256: null,
      byteLength: 12,
    },
  ],
  [
    'raster-chart',
    {
      reference: 'assets/chart-0.png',
      mediaType: 'image/png',
      sha256: 'd'.repeat(64),
      byteLength: 4096,
      figureRole: 'chart',
    },
  ],
]);

const build = (
  scenes: PlanSceneDto[],
  planDigest: string | null = null,
  extra: Record<string, unknown> = {},
): PptxDeck =>
  buildPptxDeck({
    identity: identity(planDigest),
    scenes,
    options: { media, generatedAt: '2026-10-07T00:00:00.000Z', ...extra },
  });

/** StudyError 把机器可判定的 reason 放在 details，不在面向用户的 message 里。 */
const reasonOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    const record = error as { details?: Record<string, unknown>; message?: string };
    return typeof record?.details?.['reason'] === 'string'
      ? record.details['reason']
      : `#${record?.message ?? error}`;
  }
  return 'no-error';
};

describe('pptx structure model (OMA-067)', () => {
  it('maps every scene to one editable slide with discrete shapes and source bindings', () => {
    const deck = build([slideScene([textElement(), imageElement('demo-image')])]);
    expect(deck.deckVersion).toBe(PPTX_EXPORT_VERSION);
    expect(deck.format).toBe(PPTX_EXPORT_FORMAT);
    expect(deck.slideSize).toEqual(PPTX_SLIDE_SIZES['16:9']);
    expect(deck.slides).toHaveLength(1);
    const slide = deck.slides[0]!;
    expect(slide.sceneId).toBe('scene_slide_1');
    expect(slide.editable).toBe(true);
    expect(slide.rasterized).toBe(false);
    // title / body text / formula-split runs / picture — not one flattened image
    expect(slide.shapes.map((shape) => shape.kind)).toEqual(['text', 'text', 'picture']);
    const picture = slide.shapes.find((shape) => shape.kind === 'picture') as PptxPictureShape;
    expect(picture.reference).toBe('assets/asset-0.png');
    expect(picture.referenceKind).toBe('package-relative');
    expect(picture.sha256).toBe('c'.repeat(64));
    expect(picture.sourceElementId).toBe('el_image_1');
    // notes go to the speaker notes area, not into the body
    expect(slide.notes).toBe('本场景讲解 F=ma 的适用条件');
    expect(slide.notes.length).toBeGreaterThan(0);
    expect(deck.slides.every((candidate) => candidate.shapes.length > 0)).toBe(true);
    assertPptxDeckEditable(deck);
  });

  it('scales viewport geometry to EMU with the chosen slide size', () => {
    const deck = build([slideScene([textElement()])]);
    const slide = deck.slides[0]!;
    const body = slide.shapes.find((shape) => shape.kind === 'text' && shape.textRole === 'body')!;
    if (body.kind !== 'text') throw new Error('unreachable');
    // viewport 1000x562.5 → 16:9 12192000x6858000 gives scale 12192000/1000
    const scale = 12_192_000 / 1000;
    expect(body.frame.leftEmu).toBe(Math.round(100 * scale));
    expect(body.frame.widthEmu).toBe(Math.round(600 * scale));
    expect(body.frame.widthEmu).toBeLessThanOrEqual(PPTX_SLIDE_SIZES['16:9'].widthEmu);
    expect(body.frame.leftEmu + body.frame.widthEmu).toBeLessThanOrEqual(
      PPTX_SLIDE_SIZES['16:9'].widthEmu,
    );
    expect(pptxCentipointsFromPixels(24, scale)).toBeGreaterThan(100);
    expect(EMU_PER_PIXEL).toBe(9525);
  });

  it('keeps math as editable LaTeX instead of flattening it into an image', () => {
    expect(splitFormulaSegments('质量 $m$ 与 $F = m a$ 关系')).toEqual([
      { text: '质量 ', formula: false, latex: null },
      { text: 'm', formula: true, latex: 'm' },
      { text: ' 与 ', formula: false, latex: null },
      { text: 'F = m a', formula: true, latex: 'F = m a' },
      { text: ' 关系', formula: false, latex: null },
    ]);
    const deck = build([
      slideScene([textElement({ text: '$$a = \\frac{F}{m}$$', elementId: 'el_formula_1' })]),
    ]);
    const slide = deck.slides[0]!;
    const formula = slide.shapes.find((shape) => shape.kind === 'formula');
    expect(formula).toBeDefined();
    if (formula?.kind !== 'formula') throw new Error('unreachable');
    expect(formula.latex).toBe('a = \\frac{F}{m}');
    expect(formula.representation).toBe('native-math');
    expect(formula.sourceElementId).toBe('el_formula_1');
    // a formula-bearing slide never carries a full-page snapshot
    expect(slide.shapes.some((shape) => shape.kind === 'picture')).toBe(false);
    assertPptxDeckEditable(deck);
  });

  it('keeps mixed inline math as editable formula runs inside the text shape', () => {
    const deck = build([slideScene([textElement({ text: '质量 $m$ 与加速度 a' })])]);
    const body = deck.slides[0]!.shapes.filter(
      (shape) => shape.kind === 'text' && shape.textRole === 'body',
    ).flatMap((shape) => (shape.kind === 'text' ? [shape] : []))[0]!;
    expect(body.runs.map((run) => run.text)).toEqual(['质量 ', 'm', ' 与加速度 a']);
    expect(body.runs.map((run) => run.formula)).toEqual([null, { latex: 'm' }, null]);
    expect(richTextToPlainText('质量 $m$ 与加速度 a')).toBe('质量 m 与加速度 a');
  });

  it('turns whitelisted inline markup into run styles and everything else into literal text', () => {
    const runs = richTextToRuns(
      '<b>粗</b><i>斜</i><u>下</u> H<sub>2</sub>O x<sup>2</sup> a<br>b <script>alert(1)</script>',
      {
        sizeCentipoints: 2400,
        color: '#232323',
        fontName: 'Microsoft YaHei',
        bold: false,
        italic: false,
      },
    );
    const marks = runs.map((run) => ({
      text: run.text,
      bold: run.bold,
      italic: run.italic,
      underline: run.underline,
      baseline: run.baseline,
    }));
    expect(marks).toContainEqual({
      text: '粗',
      bold: true,
      italic: false,
      underline: false,
      baseline: 'normal',
    });
    expect(marks).toContainEqual({
      text: '斜',
      bold: false,
      italic: true,
      underline: false,
      baseline: 'normal',
    });
    expect(marks).toContainEqual({
      text: '下',
      bold: false,
      italic: false,
      underline: true,
      baseline: 'normal',
    });
    expect(marks).toContainEqual({
      text: '2',
      bold: false,
      italic: false,
      underline: false,
      baseline: 'sub',
    });
    expect(marks.some((mark) => mark.baseline === 'sup' && mark.text === '2')).toBe(true);
    expect(marks.some((mark) => mark.text.includes('<script>'))).toBe(true);
    expect(runs.some((run) => run.text.includes('a\nb'))).toBe(true);
    expect(
      runs.every((run) => run.sizeCentipoints === 2400 && run.fontName === 'Microsoft YaHei'),
    ).toBe(true);
    // 逐字保留：所有运行段拼回去仍包含原文里的每个可见字符
    expect(richTextToPlainText('H<sub>2</sub>O')).toBe('H2O');
  });

  it('renders native charts, tables and diagram lines when the document projection carries them', () => {
    const deck = build([slideScene([textElement()])], null, {
      documentSceneContent: new Map([
        [
          'scene_slide_1',
          {
            canvas: {
              elements: [
                {
                  id: 'doc_chart_1',
                  type: 'chart',
                  chartType: 'bar',
                  categories: ['一', '二'],
                  series: [{ name: '销量', values: [1, 2] }],
                  left: 50,
                  top: 50,
                  width: 300,
                  height: 200,
                },
                {
                  id: 'doc_table_1',
                  type: 'table',
                  rows: [
                    ['名称', '值'],
                    ['a', '1'],
                  ],
                  left: 400,
                  top: 50,
                  width: 300,
                  height: 120,
                },
                {
                  id: 'doc_diagram_1',
                  type: 'diagram',
                  nodes: [
                    { id: 'n1', label: '起点', x: 10, y: 10 },
                    { id: 'n2', label: '终点', x: 300, y: 120 },
                  ],
                  edges: [{ from: 'n1', to: 'n2' }],
                  left: 0,
                  top: 300,
                  width: 400,
                  height: 200,
                },
              ],
            },
          },
        ],
      ]),
    });
    const kinds = deck.slides[0]!.shapes.map((shape) => shape.kind);
    expect(kinds).toContain('chart');
    expect(kinds).toContain('table');
    expect(kinds).toContain('line');
    const chart = deck.slides[0]!.shapes.find((shape) => shape.kind === 'chart')!;
    if (chart.kind !== 'chart') throw new Error('unreachable');
    expect(chart.categories).toEqual(['一', '二']);
    expect(chart.series).toEqual([{ name: '销量', values: [1, 2] }]);
    assertPptxDeckEditable(deck);
  });

  it('never puts quiz answers, analysis or points into the pptx projection', () => {
    const scenes: PlanSceneDto[] = [
      {
        sceneId: 'scene_quiz_1',
        kind: 'quiz',
        title: '测验一',
        statementId: null,
        questionId: 'q_1',
        knowledgeIds: ['kp_2'],
        elements: [],
        note: '',
      },
    ];
    const deck = build(scenes, null, {
      documentSceneContent: new Map([
        [
          'scene_quiz_1',
          {
            questions: [
              {
                id: 'q_1',
                type: 'single',
                question: '题干：F 与 a 的关系？',
                options: [
                  { label: 'A', value: 'A' },
                  { label: 'B', value: 'B' },
                ],
                answer: ['A'],
                analysis: '解析正文',
                points: 5,
              },
            ],
          },
        ],
      ]),
    });
    const serialized = JSON.stringify(deck.slides);
    expect(serialized).toContain('题干：F 与 a 的关系？');
    expect(serialized).not.toContain('解析正文');
    expect(serialized).not.toContain('"answer"');
    expect(serialized).not.toContain('"points"');
    expect(deck.slides[0]!.shapes.map((shape) => shape.kind)).toEqual([
      'text',
      'text',
      'text',
      'text',
    ]);
    assertPptxDeckEditable(deck);
  });

  it('rejects an unknown deck field instead of letting grading data ride along', () => {
    const deck = build([slideScene([textElement()])]);
    const smuggled = JSON.parse(JSON.stringify(deck)) as Record<string, unknown> & {
      slides: Record<string, unknown>[];
    };
    smuggled.slides[0]!.answer = ['A'];
    const violations = pptxDeckSchemaViolations(smuggled as unknown as PptxDeck);
    expect(violations).toContain('$.slides[0].answer');
    expect(reasonOf(() => assertPptxDeckSchemaClosed(smuggled as unknown as PptxDeck))).toBe(
      'pptx_schema_not_closed',
    );
    expect(PPTX_MODEL_KEYS.has('answer')).toBe(false);
    expect(PPTX_MODEL_KEYS.has('analysis')).toBe(false);
    assertPptxDeckSchemaClosed(deck);
  });

  it('refuses a slide whose only content is a full-page picture (whole-slide rasterisation)', () => {
    // 标题为空、正文只有一个铺满整页的图片：典型的「把课件整体拍扁」伪装
    const deck = build([
      slideScene([imageElement('demo-image', { left: 0, top: 0, width: 1000, height: 562.5 })], {
        title: ' x',
      }),
    ]);
    const rasterSlide = deck.slides[0]!;
    const flattened = {
      ...deck,
      slides: [
        {
          ...rasterSlide,
          title: '',
          shapes: rasterSlide.shapes
            .filter((shape) => shape.kind === 'picture')
            .map((shape) =>
              shape.kind === 'picture'
                ? {
                    ...shape,
                    frame: {
                      leftEmu: 0,
                      topEmu: 0,
                      widthEmu: PPTX_SLIDE_SIZES['16:9'].widthEmu,
                      heightEmu: PPTX_SLIDE_SIZES['16:9'].heightEmu,
                    },
                  }
                : shape,
            ),
          fidelity: {
            sourceElements: 1,
            shapeElements: 1,
            sourceChars: 0,
            shapeChars: 0,
            droppedElements: [],
          },
        },
      ],
    };
    const violations = pptxDeckEditabilityViolations(flattened);
    expect(violations).toContain('no_editable_content:scene_slide_1');
    expect(violations.some((violation) => violation.startsWith('whole_slide_raster:'))).toBe(true);
    expect(() => assertPptxDeckEditable(flattened)).toThrow();
    // 正常导出里同样的页面仍然带可编辑标题（栅格化判定不误伤真实课件）
    assertPptxDeckEditable(deck);
  });

  it('never writes external URLs or development paths and reports them as visible placeholders', () => {
    expect(classifyMediaReference('https://cdn.example.com/a.png')).toBe('external-url');
    expect(classifyMediaReference('D:\\temp\\a.png')).toBe('development-path');
    expect(classifyMediaReference('/home/dev/a.png')).toBe('development-path');
    expect(classifyMediaReference('assets\\a.png')).toBe('development-path');
    expect(classifyMediaReference('../outside.png')).toBe('invalid');
    expect(classifyMediaReference('assets/a.png')).toBe('package-relative');
    expect(classifyMediaReference('data:image/png;base64,AAAA')).toBe('inline-data');
    expect(classifyMediaReference('data:text/html;base64,AAAA')).toBe('invalid');
    expect(isPortableMediaReference('https://x/y.png')).toBe(false);

    const deck = build([
      slideScene([
        imageElement('https://cdn.example.com/a.png', { elementId: 'el_bad_1' }),
        imageElement('missing-image', { elementId: 'el_miss_1' }),
      ]),
    ]);
    const slideJson = JSON.stringify(deck.slides);
    // 产物正文里既不出现失效 URL，也不出现开发期绝对路径
    expect(slideJson).not.toMatch(/https?:\/\//);
    expect(slideJson).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(slideJson).not.toContain('cdn.example.com');
    // 缺口仍然逐条可查（报告里保留原引用，产物里只留脱敏文件名）
    expect(slideJson).toContain('图片未随包内联');
    const shapes = deck.slides[0]!.shapes.filter(
      (shape) => shape.kind === 'text' && shape.textRole === 'label',
    );
    expect(shapes).toHaveLength(2);
    expect(deck.issues).toContainEqual({
      code: 'asset-reference-rejected',
      sceneId: 'scene_slide_1',
      elementId: 'el_bad_1',
      reference: 'https://cdn.example.com/a.png',
      reason: 'external-url',
    });
    expect(deck.issues).toContainEqual({
      code: 'asset-unresolved',
      sceneId: 'scene_slide_1',
      elementId: 'el_miss_1',
      reference: 'missing-image',
    });
    expect(JSON.stringify({ issues: deck.issues })).toContain('cdn.example.com');
    expect(collectPptxAssetRefs([slideScene([imageElement('demo-image')])])).toEqual([
      'demo-image',
    ]);
    assertPptxDeckEditable(deck);
  });

  it('degrades interactive/pbl scenes to an editable note plus an explicit gap, never a screenshot', () => {
    const scenes: PlanSceneDto[] = [
      {
        ...slideScene([textElement()]),
        sceneId: 'scene_slide_1',
        kind: 'interactive',
        elements: [],
        statementId: null,
      },
    ];
    const deck = build(scenes);
    expect(deck.issues).toContainEqual({
      code: 'unconverted-scene',
      sceneId: 'scene_slide_1',
      reason: '互动场景依赖课堂宿主，PowerPoint 版本不含互动运行',
    });
    const kinds = deck.slides[0]!.shapes.map((shape) => shape.kind);
    expect(kinds.every((kind) => kind === 'text')).toBe(true);
    assertPptxDeckEditable(deck);
  });

  it('binds the frozen plan digest and refuses to export a drifted plan', () => {
    const scenes = [slideScene([textElement()])];
    const digest = scenePlanDigest({
      lessonId: 'lesson_1',
      lessonVersion: 1,
      bundleId: 'bundle_1',
      scenes,
    });
    expect(() => build(scenes, digest)).not.toThrow();
    expect(() => build(scenes, 'f'.repeat(64))).toThrow();
    expect(reasonOf(() => build(scenes, 'f'.repeat(64)))).toBe('pptx_plan_digest_mismatch');
  });

  it('is deterministic: the same plan produces the same digest and content', () => {
    const scenes = [slideScene([textElement(), imageElement('demo-image')])];
    const first = build(scenes);
    const second = build(scenes);
    expect(first.digest).toBe(second.digest);
    expect(pptxDeckDigest(first)).toBe(pptxDeckDigest(second));
    expect(JSON.stringify(first.slides)).toBe(JSON.stringify(second.slides));
  });

  it('fails loudly on empty or content-losing decks', () => {
    expect(reasonOf(() => buildPptxDeck({ identity: identity(), scenes: [] }))).toBe(
      'pptx_plan_has_no_scenes',
    );
    const lossy = build([slideScene([textElement()])]);
    const slides = lossy.slides.map((slide) => ({
      ...slide,
      fidelity: { ...slide.fidelity, shapeChars: 1, droppedElements: ['el_text_1'] },
    }));
    const violations = pptxDeckEditabilityViolations({ ...lossy, slides });
    expect(violations).toContain('dropped_elements:scene_slide_1:el_text_1');
    expect(violations.some((violation) => violation.startsWith('content_loss:'))).toBe(true);
    expect(reasonOf(() => assertPptxDeckEditable({ ...lossy, slides }))).toBe(
      'pptx_deck_not_editable',
    );
    const empty = pptxDeckEditabilityViolations({
      ...lossy,
      slides: [{ ...lossy.slides[0]!, shapes: [] }],
    });
    expect(empty).toContain('empty_slide:scene_slide_1');
  });

  it('keeps oversized rectangles visible as a reported deviation instead of silent cropping', () => {
    const deck = build([
      slideScene([textElement({ left: 900, top: 500, width: 400, height: 200 })]),
    ]);
    expect(deck.issues).toContainEqual({
      code: 'rect-out-of-viewport',
      sceneId: 'scene_slide_1',
      elementId: 'el_text_1',
    });
    const body = deck.slides[0]!.shapes.find(
      (shape) => shape.kind === 'text' && shape.textRole === 'body',
    )!;
    if (body.kind !== 'text') throw new Error('unreachable');
    expect(body.frame.leftEmu + body.frame.widthEmu).toBeLessThanOrEqual(
      PPTX_SLIDE_SIZES['16:9'].widthEmu,
    );
  });

  it('supports the 4:3 slide size with the same editability guarantees', () => {
    const deck = build([slideScene([textElement(), imageElement('inline-image')])], null, {
      slideSize: '4:3',
    });
    expect(deck.slideSize.name).toBe('4:3');
    const picture = deck.slides[0]!.shapes.find(
      (shape) => shape.kind === 'picture',
    ) as PptxPictureShape;
    expect(picture.referenceKind).toBe('inline-data');
    assertPptxDeckEditable(deck);
  });
});
