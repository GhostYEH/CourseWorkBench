/**
 * 可编辑 PowerPoint 导出的**结构模型**（OMA-067）。
 *
 * 这一层只回答一个问题：一份**已冻结的场景计划**能不能变成「在 PowerPoint 里还能改」的课件，
 * 而不是把整页拍扁成一张图。验收原文是「文字/公式/图像/图表可编辑，不把课件整体栅格化」，
 * 因此这里的规则是：
 *
 * - 每个场景得到一张幻灯片，幻灯片里是**逐元素离散的可编辑形状**（文本框 / 图片 / 公式 /
 *   原生图表 / 原生表格 / 线条），形状与计划元素一一对应并保留 `sourceElementId`；
 * - 正文富文本被解析成**带样式的文本运行段**（粗体/斜体/下划线/上下标基线/字号/颜色/字体名），
 *   `$…$`、`$$…$$`、`\(…\)`、`\[…\]` 内的数学保留 **LaTeX 源码**作为可编辑公式——公式永不转成贴图，
 *   退化路径也只是保留可编辑纯文本，并同时登记 `formula-text-fallback` 缺口；
 * - 计划里的备注进入幻灯片**备注栏**（`notes`），不混进正文，也不用截图代替；
 * - 图片只承认**包内相对路径 / `data:` 内联**两类可移植引用（OMA-072）。外部 URL、盘符、
 *   UNC、`/` 开头绝对路径与反斜杠路径一律拒绝写入产物，改为一条**可见的占位文本形状**并登记缺口，
 *   既不出现失效引用，也不静默丢内容；
 * - 「整页栅格化」在结构上无法表达：模型里没有「整页快照」这种形状，且
 *   `assertPptxDeckEditable` 会拒绝「没有文字/公式形状却有一张铺满版的图片」这类伪可编辑产物；
 * - 判分依据不会进入 PPTX：测验只投影题干与选项文字，且产物每个对象键都必须在
 *   `PPTX_MODEL_KEYS` 白名单内（`assertPptxDeckSchemaClosed`），`answer`/`analysis`/`points`
 *   结构上无处藏身，而不是靠文案声明。
 *
 * 纯函数：不做 IO、不依赖任何 pptx 库、不启动渲染进程。字节级 OOXML/ZIP 序列化属于合同接入侧
 * （需要 `LESSON_EXPORT_FORMATS` 增加 `'pptx'`，见交付报告）。
 */

import { RICH_TEXT_TAGS, StudyError, type PlanSceneDto } from '@sew/study-contracts';
import { canonicalJson } from './classroom';
import { fingerprintOf } from './normalize';
import { scenePlanDigest } from './scene-plan';

/** 结构模型版本。 */
export const PPTX_EXPORT_VERSION = 1;
/** 导出格式标识：与 contracts 请求扩展后的 `format` 取值一致。 */
export const PPTX_EXPORT_FORMAT = 'pptx';

/** PowerPoint 用 EMU 表示几何：1px（CSS @96dpi）= 9525 EMU。 */
export const EMU_PER_PIXEL = 9525;

/** 数学定界符（与 `splitFormulaSegments` 同源，长定界符优先匹配）。 */
const FORMULA_DELIMITERS: readonly (readonly [string, string])[] = [
  ['$$', '$$'],
  ['\\[', '\\]'],
  ['\\(', '\\)'],
  ['$', '$'],
];

/** 与既有 HTML 导出同一套画布默认值（viewportSize / viewportRatio）。 */
const DEFAULT_VIEWPORT_SIZE = 1000;
const DEFAULT_VIEWPORT_RATIO = 0.5625;
/** 与 `planElementSchema.text` 的 4000 字上限对齐：异常输入拒绝而不是截断伪装。 */
const MAX_ELEMENT_TEXT = 4000;

export type PptxSlideSizeName = '16:9' | '4:3';

export interface PptxSlideSize {
  readonly name: PptxSlideSizeName;
  readonly widthEmu: number;
  readonly heightEmu: number;
  readonly aspectRatio: number;
}

export const PPTX_SLIDE_SIZES: Readonly<Record<PptxSlideSizeName, PptxSlideSize>> = {
  '16:9': { name: '16:9', widthEmu: 12_192_000, heightEmu: 6_858_000, aspectRatio: 16 / 9 },
  '4:3': { name: '4:3', widthEmu: 9_144_000, heightEmu: 6_858_000, aspectRatio: 4 / 3 },
};

/** 幻灯片默认配色与默认字体：形状没有逐元素样式时由它兜底。 */
export interface PptxTheme {
  readonly backgroundColor: string;
  readonly fontColor: string;
  readonly fontName: string;
}

const DEFAULT_THEME: PptxTheme = {
  backgroundColor: '#f4f6fb',
  fontColor: '#232323',
  fontName: 'Microsoft YaHei',
};

/** 一个形状的位置尺寸（EMU，整数）。 */
export interface PptxFrame {
  readonly leftEmu: number;
  readonly topEmu: number;
  readonly widthEmu: number;
  readonly heightEmu: number;
}

/**
 * 文本运行段：PowerPoint 里可逐字编辑的一段文字。
 * `formula` 非 null 表示这一段是**数学**，`latex` 为排版源码（null 表示源里只有可读文本、
 * 没有排版源码），写入方据此选择原生公式对象或普通文本——两者都仍是可编辑元素。
 */
export interface PptxTextRun {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly baseline: 'normal' | 'sub' | 'sup';
  readonly sizeCentipoints: number;
  readonly color: string;
  readonly fontName: string;
  readonly formula: { readonly latex: string | null } | null;
}

export type PptxTextRole = 'title' | 'body' | 'stem' | 'option' | 'note' | 'label';

export interface PptxTextShape {
  readonly kind: 'text';
  readonly shapeId: string;
  readonly sceneId: string;
  readonly sourceElementId: string | null;
  readonly editable: true;
  readonly textRole: PptxTextRole;
  readonly frame: PptxFrame;
  readonly runs: readonly PptxTextRun[];
  readonly alignment: 'left' | 'center' | 'right';
  readonly lineHeight: number;
}

/**
 * 图片形状：引用必须**可移植**（包内相对路径或 `data:` 内联）。
 * `figureRole` 标明原件用途；图表/公式若只以贴图形态冻结，会被标记为 `chart-raster-only`
 * 缺口，而不是冒充「可编辑图表」。
 */
export interface PptxPictureShape {
  readonly kind: 'picture';
  readonly shapeId: string;
  readonly sceneId: string;
  readonly sourceElementId: string | null;
  readonly editable: true;
  readonly frame: PptxFrame;
  readonly reference: string;
  readonly referenceKind: 'package-relative' | 'inline-data';
  readonly mediaType: string;
  readonly sha256: string | null;
  readonly byteLength: number | null;
  readonly figureRole: 'image' | 'chart' | 'formula' | 'diagram';
}

/** 独占一格的可编辑公式：保留 LaTeX 源码，`representation` 如实说明退化路径。 */
export interface PptxFormulaShape {
  readonly kind: 'formula';
  readonly shapeId: string;
  readonly sceneId: string;
  readonly sourceElementId: string | null;
  readonly editable: true;
  readonly frame: PptxFrame;
  readonly representation: 'native-math' | 'editable-text';
  readonly latex: string | null;
  readonly plainText: string;
  readonly sizeCentipoints: number;
}

/** 原生图表（类别 + 系列数值）：写入方产出 PowerPoint 图表部件，用户可直接改数据。 */
export interface PptxChartShape {
  readonly kind: 'chart';
  readonly shapeId: string;
  readonly sceneId: string;
  readonly sourceElementId: string | null;
  readonly editable: true;
  readonly frame: PptxFrame;
  readonly chartType: 'bar' | 'line' | 'pie';
  readonly categories: readonly string[];
  readonly series: readonly { readonly name: string; readonly values: readonly number[] }[];
}

/** 原生表格：每格都是可编辑单元格。 */
export interface PptxTableShape {
  readonly kind: 'table';
  readonly shapeId: string;
  readonly sceneId: string;
  readonly sourceElementId: string | null;
  readonly editable: true;
  readonly frame: PptxFrame;
  readonly rows: readonly (readonly string[])[];
  readonly firstRowIsHeader: boolean;
}

/** 简图连线：把 diagram 的边画成真正的线条形状（可拖动、可删除）。 */
export interface PptxLineShape {
  readonly kind: 'line';
  readonly shapeId: string;
  readonly sceneId: string;
  readonly sourceElementId: string | null;
  readonly editable: true;
  readonly startEmu: { readonly xEmu: number; readonly yEmu: number };
  readonly endEmu: { readonly xEmu: number; readonly yEmu: number };
  readonly widthEmu: number;
}

export type PptxShape =
  | PptxTextShape
  | PptxPictureShape
  | PptxFormulaShape
  | PptxChartShape
  | PptxTableShape
  | PptxLineShape;

/** 单场景保真度计数：写完对一遍，「静默丢内容」当场暴露。 */
export interface PptxFidelity {
  readonly sourceElements: number;
  readonly shapeElements: number;
  readonly sourceChars: number;
  readonly shapeChars: number;
  readonly droppedElements: readonly string[];
}

export interface PptxSlide {
  readonly index: number;
  readonly sceneId: string;
  readonly sceneKind: PlanSceneDto['kind'];
  readonly title: string;
  readonly editable: true;
  readonly rasterized: false;
  readonly shapes: readonly PptxShape[];
  readonly notes: string;
  readonly fidelity: PptxFidelity;
}

/** 逐条可见的转换缺口/偏差说明（与 HTML 导出「缺口必须可见」同一口径）。 */
export type PptxIssue =
  | { readonly code: 'unconverted-scene'; readonly sceneId: string; readonly reason: string }
  | {
      readonly code: 'asset-unresolved';
      readonly sceneId: string;
      readonly elementId: string;
      readonly reference: string;
    }
  | {
      readonly code: 'asset-reference-rejected';
      readonly sceneId: string;
      readonly elementId: string;
      readonly reference: string;
      readonly reason: 'external-url' | 'development-path' | 'invalid';
    }
  | { readonly code: 'rect-out-of-viewport'; readonly sceneId: string; readonly elementId: string }
  | { readonly code: 'formula-text-fallback'; readonly sceneId: string; readonly elementId: string }
  | { readonly code: 'chart-raster-only'; readonly sceneId: string; readonly elementId: string }
  | { readonly code: 'quiz-scene-degraded'; readonly sceneId: string; readonly reason: string };

/** 库中确实存在且可移植的图片事实（由调用方从权威存储读出并可内联）。 */
export interface PptxMediaFact {
  readonly reference: string;
  readonly mediaType: string;
  readonly sha256: string | null;
  readonly byteLength: number | null;
  readonly figureRole?: 'image' | 'chart' | 'formula' | 'diagram';
}

export interface PptxDeckIdentity {
  readonly projectId: string;
  readonly lessonId: string;
  readonly lessonVersion: number;
  readonly bundleId: string;
  readonly title: string;
  readonly stageId: string | null;
  readonly dslVersion: string | null;
  /** 权威文档摘要与「已移除判分依据的投影」摘要，与 HTML 导出同一口径。 */
  readonly documentDigest: string | null;
  readonly exportedDocumentDigest: string | null;
  /** 冻结场景计划内容摘要；给定时必须与传入场景相符，否则拒绝导出。 */
  readonly planDigest: string | null;
}

export interface BuildPptxDeckOptions {
  readonly slideSize?: PptxSlideSizeName;
  readonly viewportSize?: number;
  readonly viewportRatio?: number;
  readonly theme?: Partial<PptxTheme>;
  /** `assetRef` → 可移植内联事实。缺席即登记缺口并保留可见占位，不猜测路径。 */
  readonly media?: ReadonlyMap<string, PptxMediaFact>;
  /**
   * 装配好的正式课件文档里各场景的 `content`（sceneId → content）。
   * 只读展示字段（测验题干/选项、图表数据、表格、简图节点），不读判分字段。
   */
  readonly documentSceneContent?: ReadonlyMap<string, unknown>;
  readonly generatedAt?: string;
}

export interface BuildPptxDeckInput {
  readonly identity: PptxDeckIdentity;
  readonly scenes: readonly PlanSceneDto[];
  readonly options?: BuildPptxDeckOptions;
}

export interface PptxDeck {
  readonly deckVersion: number;
  readonly format: 'pptx';
  readonly generatedAt: string;
  readonly identity: PptxDeckIdentity;
  readonly slideSize: PptxSlideSize;
  readonly theme: PptxTheme;
  readonly canvas: { readonly viewportSize: number; readonly viewportRatio: number };
  readonly slides: readonly PptxSlide[];
  readonly issues: readonly PptxIssue[];
  readonly digest: string;
}

// ——————————————————————— 媒体引用可移植判定（OMA-072 同源） ———————————————————————

export type MediaReferenceKind =
  'package-relative' | 'inline-data' | 'external-url' | 'development-path' | 'invalid';

const INLINE_DATA_MIME = /^(?:image\/(?:png|jpe?g|gif|webp)|font\/(?:woff2?|ttf|otf))$/i;

/**
 * 分类一个媒体引用，判断它能否进入导出产物。
 *
 * 只有「包内相对 POSIX 路径」与受控的 `data:` 图片/字体内联算可移植。外部 URL、盘符、UNC、
 * `/` 开头绝对路径、反斜杠、`..` 越界与控制字符全部拒绝——产物在新机器/新实例上必须凭自身
 * 就能解引用，不能依赖旧浏览器缓存或本机目录结构。
 */
export const classifyMediaReference = (reference: string): MediaReferenceKind => {
  if (reference.length === 0 || reference.length > 200) return 'invalid';
  if (/[\u0000-\u001f\u007f]/.test(reference)) return 'invalid';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(reference) || reference.startsWith('//'))
    return 'external-url';
  if (/^[a-z]:[\\/]/i.test(reference) || reference.startsWith('\\\\')) return 'development-path';
  if (reference.startsWith('/') || reference.includes('\\')) return 'development-path';
  if (reference.startsWith('data:')) {
    const payload = reference.slice('data:'.length);
    const comma = payload.indexOf(',');
    const mime = (comma < 0 ? payload : payload.slice(0, comma)).split(';')[0] ?? '';
    // 只允许静态位图/字体内联；HTML、SVG 等可执行/可脚本形态不进产物。
    return INLINE_DATA_MIME.test(mime.trim()) ? 'inline-data' : 'invalid';
  }
  const segments = reference.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    return 'invalid';
  if (segments.some((segment) => segment.includes(':'))) return 'invalid';
  return 'package-relative';
};

export const isPortableMediaReference = (reference: string): boolean => {
  const kind = classifyMediaReference(reference);
  return kind === 'package-relative' || kind === 'inline-data';
};

/**
 * 被拒绝引用的**脱敏摘要**：只保留最后一段文件名。
 *
 * 占位文字会进入学件正文，因此不能把失效 URL 或开发期绝对路径写回产物（OMA-072）；
 * 完整引用仍然记在 `issues` 报告里（那是给人看的缺口清单，不是产物内的引用）。
 */
export const redactedReferenceHint = (reference: string): string => {
  const segments = reference.split(/[\\/]/);
  const last = (segments[segments.length - 1] ?? '').split(/[?#]/)[0] ?? '';
  const cleaned = last.replace(/[\u0000-\u001f\u007f<>"]/g, '').slice(0, 40);
  return cleaned.length > 0 ? cleaned : '（无法归类的引用）';
};

// ——————————————————————— 数学定界符切分 ———————————————————————

export interface FormulaSegment {
  readonly text: string;
  readonly formula: boolean;
  readonly latex: string | null;
}

/**
 * 按数学定界符把正文切成「文本段 / 公式段」：公式段保留**原始 LaTeX 源码**（可编辑），
 * 文本段逐字保留，定界符本身不进入正文。空公式（`$$$$`）与没有闭合定界符的片段按字面文本处理。
 */
export const splitFormulaSegments = (value: string): FormulaSegment[] => {
  const segments: FormulaSegment[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer.length > 0) {
      segments.push({ text: buffer, formula: false, latex: null });
      buffer = '';
    }
  };
  let index = 0;
  while (index < value.length) {
    const escaped = index > 0 && value[index - 1] === '\\';
    let delimiter: readonly [string, string] | null = null;
    if (!escaped) {
      for (const candidate of FORMULA_DELIMITERS) {
        if (value.startsWith(candidate[0], index)) {
          delimiter = candidate;
          break;
        }
      }
    }
    if (!delimiter) {
      buffer += value[index];
      index += 1;
      continue;
    }
    const bodyStart = index + delimiter[0].length;
    const closeAt = value.indexOf(delimiter[1], bodyStart);
    if (closeAt < 0) {
      buffer += delimiter[0];
      index = bodyStart;
      continue;
    }
    const body = value.slice(bodyStart, closeAt);
    if (body.trim().length === 0) {
      buffer += delimiter[0] + body + delimiter[1];
      index = closeAt + delimiter[1].length;
      continue;
    }
    flush();
    segments.push({ text: body, formula: true, latex: body.trim() });
    index = closeAt + delimiter[1].length;
  }
  flush();
  return segments;
};

/** 整段正文就是一个公式时返回它（用于把公式落成独占的可编辑公式形状）。 */
const wholeTextFormula = (
  value: string,
): { readonly latex: string | null; readonly plain: string } | null => {
  const segments = splitFormulaSegments(value);
  const only = segments.length === 1 ? segments[0] : undefined;
  if (!only?.formula) return null;
  return { latex: only.latex, plain: only.text };
};

// ——————————————————————— 富文本 → 可编辑运行段 ———————————————————————

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

const decodeEntities = (value: string): string =>
  value.replace(/&(#[xX][\da-f]+|#\d+|[a-zA-Z]+);/g, (entity, key: string) => {
    if (!key.startsWith('#')) return ENTITIES[key.toLowerCase()] ?? entity;
    const point =
      key[1]?.toLowerCase() === 'x'
        ? Number.parseInt(key.slice(2), 16)
        : Number.parseInt(key.slice(1), 10);
    return point > 0 && point <= 0x10ff_ff && !(point >= 0xd800 && point <= 0xdf_ff)
      ? String.fromCodePoint(point)
      : '\ufffd';
  });

/** 属性一律丢弃：计划层已用 `style` 给出样式，正文里的属性串只能当文本，不成为可执行内容。 */
const TAG_TOKEN = /^<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>$/i;
const TOKEN_PATTERN = /<[^>]*>|[^<]+|</g;

interface RunStyle {
  readonly sizeCentipoints: number;
  readonly color: string;
  readonly fontName: string;
  readonly bold: boolean;
  readonly italic: boolean;
}

interface MutableRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  baseline: 'normal' | 'sub' | 'sup';
  sizeCentipoints: number;
  color: string;
  fontName: string;
  formula: { latex: string | null } | null;
}

const sameMarks = (left: MutableRun, right: MutableRun): boolean =>
  left.bold === right.bold &&
  left.italic === right.italic &&
  left.underline === right.underline &&
  left.baseline === right.baseline &&
  left.formula === null &&
  right.formula === null;

/**
 * 把计划元素正文变成**带样式的文本运行段**：
 * - 白名单行内标记（`b`/`i`/`u`/`sub`/`sup`/`span`/`br`）转成运行段样式，`br` 转成 `\n`；
 * - 非白名单标记与落单的 `<` 按字面文本保留（正文变成文本，不会变成 markup 或脚本）；
 * - 数学定界符内的片段作为可编辑公式运行段（保留 LaTeX 源码）。
 *
 * 正文逐字保留且仍可编辑——这是「可编辑不栅格化」在文本侧的实现。
 */
export const richTextToRuns = (value: string, style: RunStyle): PptxTextRun[] => {
  if (value.length > MAX_ELEMENT_TEXT) {
    throw new StudyError('INVALID_ARGUMENT', {
      reason: 'pptx_element_text_too_long',
      length: value.length,
    });
  }
  const runs: MutableRun[] = [];
  const open: string[] = [];
  const emit = (segment: string, formula: { latex: string | null } | null): void => {
    if (segment.length === 0) return;
    const run: MutableRun = {
      text: segment,
      bold: style.bold || open.includes('b'),
      italic: style.italic || open.includes('i'),
      underline: open.includes('u'),
      baseline: open.includes('sup') ? 'sup' : open.includes('sub') ? 'sub' : 'normal',
      sizeCentipoints: style.sizeCentipoints,
      color: style.color,
      fontName: style.fontName,
      formula,
    };
    const last = runs[runs.length - 1];
    if (last && sameMarks(last, run)) last.text += run.text;
    else runs.push(run);
  };
  const emitPlainText = (token: string): void => {
    const decoded = decodeEntities(token).replace(/\r?\n/g, '\n');
    for (const segment of splitFormulaSegments(decoded)) {
      emit(segment.text, segment.formula ? { latex: segment.latex } : null);
    }
  };
  for (const token of value.match(TOKEN_PATTERN) ?? []) {
    const match = TAG_TOKEN.exec(token);
    const tag = match?.[2]?.toLowerCase();
    if (!match || !tag || !(RICH_TEXT_TAGS as readonly string[]).includes(tag)) {
      emitPlainText(token);
      continue;
    }
    const closing = Boolean(match[1]);
    const selfClosing = Boolean(match[3]);
    if (tag === 'br') {
      if (!closing) emit('\n', null);
      continue;
    }
    if (closing) {
      const at = open.lastIndexOf(tag);
      if (at >= 0) open.splice(at, 1);
      else emitPlainText(token);
      continue;
    }
    if (!selfClosing) open.push(tag);
  }
  return runs;
};

/** 富文本的纯文本形式（保真度计数、时长估算等），逐字对应可编辑正文。 */
export const richTextToPlainText = (value: string): string =>
  richTextToRuns(value, {
    sizeCentipoints: 100,
    color: '#000000',
    fontName: '',
    bold: false,
    italic: false,
  })
    .map((run) => run.text)
    .join('');

// ——————————————————————— 几何与字号映射 ———————————————————————

/** 视口像素 → EMU 的等比缩放系数（内容不裁切、比例不变）。 */
export const pptxScaleOf = (input: {
  readonly viewportSize: number;
  readonly viewportRatio: number;
  readonly slideSize: PptxSlideSize;
}): number =>
  Math.min(
    input.slideSize.widthEmu / input.viewportSize,
    input.slideSize.heightEmu / (input.viewportSize * input.viewportRatio),
  );

/** 视口像素字号 → 厘点（ct/100 pt）：随版式等比缩放，不出现「小一号伪装」。 */
export const pptxCentipointsFromPixels = (pixels: number, scale: number): number =>
  Math.max(100, Math.round((pixels * 75 * scale) / EMU_PER_PIXEL));

// ——————————————————————— 结构白名单（判分依据结构上无处可放） ———————————————————————

/** 产物模型允许出现的**全部**对象键。新增字段必须先入此表，否则视为未审计内容。 */
export const PPTX_MODEL_KEYS: ReadonlySet<string> = new Set([
  'deckVersion',
  'format',
  'generatedAt',
  'identity',
  'slideSize',
  'theme',
  'canvas',
  'slides',
  'issues',
  'digest',
  'projectId',
  'lessonId',
  'lessonVersion',
  'bundleId',
  'title',
  'stageId',
  'dslVersion',
  'documentDigest',
  'exportedDocumentDigest',
  'planDigest',
  'name',
  'widthEmu',
  'heightEmu',
  'aspectRatio',
  'backgroundColor',
  'fontColor',
  'fontName',
  'viewportSize',
  'viewportRatio',
  'index',
  'sceneId',
  'sceneKind',
  'editable',
  'rasterized',
  'shapes',
  'notes',
  'fidelity',
  'sourceElements',
  'shapeElements',
  'sourceChars',
  'shapeChars',
  'droppedElements',
  'kind',
  'shapeId',
  'sourceElementId',
  'textRole',
  'frame',
  'runs',
  'alignment',
  'lineHeight',
  'reference',
  'referenceKind',
  'mediaType',
  'sha256',
  'byteLength',
  'figureRole',
  'leftEmu',
  'topEmu',
  'text',
  'bold',
  'italic',
  'underline',
  'baseline',
  'sizeCentipoints',
  'color',
  'formula',
  'latex',
  'representation',
  'plainText',
  'chartType',
  'categories',
  'series',
  'values',
  'rows',
  'firstRowIsHeader',
  'startEmu',
  'endEmu',
  'xEmu',
  'yEmu',
  'code',
  'reason',
  'elementId',
]);

const findUnknownKeys = (value: unknown, allowed: ReadonlySet<string>, path: string): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findUnknownKeys(item, allowed, `${path}[${index}]`));
  }
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const offenders = keys.filter((key) => !allowed.has(key)).map((key) => `${path}.${key}`);
  for (const key of keys)
    offenders.push(...findUnknownKeys(record[key], allowed, `${path}.${key}`));
  return offenders;
};

/** 审计产物「能放哪些字段」：只遍历键结构，值不参与判定（不做 JSON 往返，领域层保持零解码）。 */
export const pptxDeckSchemaViolations = (deck: PptxDeck): string[] =>
  findUnknownKeys(deck, PPTX_MODEL_KEYS, '$');

export const assertPptxDeckSchemaClosed = (deck: PptxDeck): void => {
  const violations = pptxDeckSchemaViolations(deck);
  if (violations.length > 0) {
    throw new StudyError('INVALID_ARGUMENT', {
      reason: 'pptx_schema_not_closed',
      paths: violations.slice(0, 20),
    });
  }
};

// ——————————————————————— 构建 ———————————————————————

interface SlideContext {
  readonly scale: number;
  readonly slideSize: PptxSlideSize;
  readonly theme: PptxTheme;
  readonly viewportSize: number;
  readonly viewportHeight: number;
  readonly media: ReadonlyMap<string, PptxMediaFact>;
  readonly documentContent: unknown;
  readonly issues: PptxIssue[];
}

const shapeChars = (shape: PptxShape): number => {
  if (shape.kind === 'text') return shape.runs.reduce((total, run) => total + run.text.length, 0);
  if (shape.kind === 'formula') return shape.plainText.length;
  if (shape.kind === 'table')
    return shape.rows.reduce((total, row) => total + row.join('').length, 0);
  if (shape.kind === 'chart') {
    return (
      shape.categories.join('').length +
      shape.series.reduce((total, series) => total + series.name.length, 0)
    );
  }
  return 0;
};

const buildSlide = (scene: PlanSceneDto, index: number, context: SlideContext): PptxSlide => {
  const shapes: PptxShape[] = [];
  const dropped: string[] = [];
  let sourceElements = 0;
  let sourceChars = 0;
  let counter = 0;
  const nextShapeId = (): string => `shape_${scene.sceneId}_${(counter += 1)}`;

  const frameOf = (
    box: { left: number; top: number; width: number; height: number },
    elementId: string,
  ): PptxFrame => {
    if (
      elementId.length > 0 &&
      (box.left < 0 ||
        box.top < 0 ||
        box.left + box.width > context.viewportSize + 1 ||
        box.top + box.height > context.viewportHeight + 1)
    ) {
      context.issues.push({ code: 'rect-out-of-viewport', sceneId: scene.sceneId, elementId });
    }
    const leftEmu = Math.max(
      0,
      Math.round(Math.min(Math.max(box.left, 0), context.viewportSize) * context.scale),
    );
    const topEmu = Math.max(
      0,
      Math.round(Math.min(Math.max(box.top, 0), context.viewportHeight) * context.scale),
    );
    return {
      leftEmu,
      topEmu,
      widthEmu: Math.max(
        1,
        Math.min(Math.round(box.width * context.scale), context.slideSize.widthEmu - leftEmu),
      ),
      heightEmu: Math.max(
        1,
        Math.min(Math.round(box.height * context.scale), context.slideSize.heightEmu - topEmu),
      ),
    };
  };

  const fractionFrame = (left: number, top: number, width: number, height: number): PptxFrame => ({
    leftEmu: Math.round(context.slideSize.widthEmu * left),
    topEmu: Math.round(context.slideSize.heightEmu * top),
    widthEmu: Math.round(context.slideSize.widthEmu * width),
    heightEmu: Math.round(context.slideSize.heightEmu * height),
  });

  const pushText = (
    text: string,
    style: {
      readonly fontSize: number;
      readonly color: string;
      readonly align: 'left' | 'center' | 'right';
      readonly bold?: boolean;
      readonly italic?: boolean;
    },
    frame: PptxFrame,
    textRole: PptxTextRole,
    sourceElementId: string | null,
  ): void => {
    const base: RunStyle = {
      sizeCentipoints: pptxCentipointsFromPixels(style.fontSize, context.scale),
      color: style.color,
      fontName: context.theme.fontName,
      bold: style.bold ?? false,
      italic: style.italic ?? false,
    };
    const formula = wholeTextFormula(text);
    if (formula) {
      if (formula.latex === null) {
        context.issues.push({
          code: 'formula-text-fallback',
          sceneId: scene.sceneId,
          elementId: sourceElementId ?? textRole,
        });
      }
      shapes.push({
        kind: 'formula',
        shapeId: nextShapeId(),
        sceneId: scene.sceneId,
        sourceElementId,
        editable: true,
        frame,
        representation: formula.latex === null ? 'editable-text' : 'native-math',
        latex: formula.latex,
        plainText: formula.plain,
        sizeCentipoints: base.sizeCentipoints,
      });
      return;
    }
    const runs = richTextToRuns(text, base);
    if (runs.length === 0) {
      if (text.trim().length > 0) dropped.push(sourceElementId ?? textRole);
      return;
    }
    shapes.push({
      kind: 'text',
      shapeId: nextShapeId(),
      sceneId: scene.sceneId,
      sourceElementId,
      editable: true,
      textRole,
      frame,
      runs,
      alignment: style.align,
      lineHeight: 1.5,
    });
  };

  const pushMissingMedia = (
    reference: string,
    frame: PptxFrame,
    sourceElementId: string,
    reason: string,
  ): void => {
    // 缺口可见化：图片以一条可编辑文本占位（而不是坏链、也不是整页截图），内容不静默消失。
    shapes.push({
      kind: 'text',
      shapeId: nextShapeId(),
      sceneId: scene.sceneId,
      sourceElementId,
      editable: true,
      textRole: 'label',
      frame,
      runs: [
        {
          text: `图片未随包内联（${reason}）：${redactedReferenceHint(reference)}`,
          bold: false,
          italic: false,
          underline: false,
          baseline: 'normal',
          sizeCentipoints: pptxCentipointsFromPixels(14, context.scale),
          color: context.theme.fontColor,
          fontName: context.theme.fontName,
          formula: null,
        },
      ],
      alignment: 'left',
      lineHeight: 1.5,
    });
  };

  const pushTitle = (): void => {
    const title = scene.title.trim();
    if (title.length === 0) return;
    sourceChars += richTextToPlainText(title).length;
    pushText(
      title,
      { fontSize: scene.kind === 'slide' ? 32 : 28, color: context.theme.fontColor, align: 'left' },
      fractionFrame(0.06, 0.05, 0.88, 0.15),
      'title',
      null,
    );
  };

  if (scene.kind === 'slide') {
    pushTitle();
    // Empty plan elements are a skeleton: the reviewed document contains its actual frozen body.
    for (const element of scene.elements.length
      ? scene.elements
      : documentSlideElements(context.documentContent)) {
      if (element.kind !== 'image' && richTextToPlainText(element.text).trim().length === 0) {
        // 计划里允许存在空正文元素：它不承载内容，因此既不算丢失也不算未表示。
        continue;
      }
      sourceElements += 1;
      const frame = frameOf(
        { left: element.left, top: element.top, width: element.width, height: element.height },
        element.elementId,
      );
      if (element.kind === 'image') {
        const reference = element.assetRef ?? '';
        const facts = reference.length > 0 ? context.media.get(reference) : undefined;
        if (facts) {
          const figureRole = facts.figureRole ?? 'image';
          if (figureRole === 'chart') {
            context.issues.push({
              code: 'chart-raster-only',
              sceneId: scene.sceneId,
              elementId: element.elementId,
            });
          }
          const kind = classifyMediaReference(facts.reference);
          shapes.push({
            kind: 'picture',
            shapeId: nextShapeId(),
            sceneId: scene.sceneId,
            sourceElementId: element.elementId,
            editable: true,
            frame,
            reference: facts.reference,
            referenceKind: kind === 'inline-data' ? 'inline-data' : 'package-relative',
            mediaType: facts.mediaType,
            sha256: facts.sha256,
            byteLength: facts.byteLength,
            figureRole,
          });
          continue;
        }
        const rejected = reference.length === 0 ? 'invalid' : classifyMediaReference(reference);
        if (
          rejected === 'external-url' ||
          rejected === 'development-path' ||
          rejected === 'invalid'
        ) {
          context.issues.push({
            code: 'asset-reference-rejected',
            sceneId: scene.sceneId,
            elementId: element.elementId,
            reference,
            reason: rejected,
          });
          pushMissingMedia(reference || '（未指定）', frame, element.elementId, rejected);
          continue;
        }
        context.issues.push({
          code: 'asset-unresolved',
          sceneId: scene.sceneId,
          elementId: element.elementId,
          reference,
        });
        pushMissingMedia(reference, frame, element.elementId, '库中无唯一正式绑定资源');
        continue;
      }
      sourceChars += richTextToPlainText(element.text).length;
      pushText(
        element.text,
        {
          fontSize: element.style.fontSize,
          color: element.style.color,
          align: element.style.align,
          bold: element.style.bold,
          italic: element.style.italic,
        },
        frame,
        'body',
        element.elementId,
      );
    }
  } else if (scene.kind === 'quiz') {
    pushTitle();
    const questions = readQuizProjection(context.documentContent);
    if (questions.length === 0) {
      context.issues.push({
        code: 'quiz-scene-degraded',
        sceneId: scene.sceneId,
        reason: '文档投影没有可投影的题干/选项，仅保留场景标题',
      });
    }
    for (const question of questions) {
      sourceElements += 1;
      sourceChars +=
        richTextToPlainText(question.stem).length +
        question.options.reduce((total, option) => total + option.length, 0);
      pushText(
        question.stem,
        { fontSize: 22, color: context.theme.fontColor, align: 'left' },
        fractionFrame(0.06, 0.24, 0.88, 0.18),
        'stem',
        question.questionId ?? scene.sceneId,
      );
      question.options.forEach((option, optionIndex) => {
        pushText(
          option,
          { fontSize: 18, color: context.theme.fontColor, align: 'left' },
          fractionFrame(0.1, 0.44 + optionIndex * 0.1, 0.84, 0.09),
          'option',
          `${question.questionId ?? scene.sceneId}:option:${optionIndex}`,
        );
      });
    }
  } else {
    pushTitle();
    // 互动/PBL 在 PowerPoint 里没有对应的可执行载体：只保留标题 + 一行可编辑说明，
    // 并如实登记「未完整转换」。绝不把互动界面截成一张图冒充内容。
    context.issues.push({
      code: 'unconverted-scene',
      sceneId: scene.sceneId,
      reason:
        scene.kind === 'interactive'
          ? '互动场景依赖课堂宿主，PowerPoint 版本不含互动运行'
          : 'PBL 公开项目设计为只读投影，PowerPoint 不含提交、导师与评价运行',
    });
    const notice =
      scene.kind === 'interactive'
        ? '（互动场景：请在课堂中打开；本节 PowerPoint 幻灯片不含互动运行内容。）'
        : '（PBL 场景：项目设计为只读投影；提交、导师与评价请在课堂中打开。）';
    pushText(
      notice,
      { fontSize: 16, color: context.theme.fontColor, align: 'left' },
      fractionFrame(0.06, 0.3, 0.88, 0.2),
      'note',
      null,
    );
    if (scene.kind === 'pbl') {
      const content = context.documentContent as {
        projectV2?: { description?: unknown; learningObjective?: unknown };
      } | null;
      const project = content?.projectV2;
      const text = [project?.description, project?.learningObjective]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join('\n\n');
      if (text) {
        sourceChars += richTextToPlainText(text).length;
        pushText(
          text,
          { fontSize: 16, color: context.theme.fontColor, align: 'left' },
          fractionFrame(0.06, 0.5, 0.88, 0.44),
          'body',
          scene.sceneId,
        );
      }
    }
  }

  shapes.push(...documentStructures(scene, context, nextShapeId));

  return {
    index,
    sceneId: scene.sceneId,
    sceneKind: scene.kind,
    title: scene.title,
    editable: true,
    rasterized: false,
    shapes,
    notes: scene.note,
    fidelity: {
      sourceElements,
      shapeElements: shapes.filter((shape) => shape.sourceElementId !== null).length,
      sourceChars,
      shapeChars: shapes.reduce((total, shape) => total + shapeChars(shape), 0),
      droppedElements: dropped,
    },
  };
};

/** Only the reviewed document's public text/image fields become editable body elements. */
const documentSlideElements = (content: unknown): PlanSceneDto['elements'] => {
  const elements = (content as { canvas?: { elements?: unknown } } | null)?.canvas?.elements;
  if (!Array.isArray(elements)) return [];
  return elements.flatMap((raw, index): PlanSceneDto['elements'] => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    if (item['type'] !== 'text' && item['type'] !== 'image') return [];
    const text =
      item['type'] === 'text' && typeof item['content'] === 'string' ? item['content'] : '';
    const css = text.match(/<p\b[^>]*style="([^"]*)"/i)?.[1] ?? '';
    const number = (key: string, fallback: number): number =>
      typeof item[key] === 'number' && Number.isFinite(item[key])
        ? (item[key] as number)
        : fallback;
    const align = css.match(/text-align:\s*(left|center|right)/)?.[1];
    return [
      {
        elementId: typeof item['id'] === 'string' ? item['id'] : `document_element_${index}`,
        kind: item['type'] === 'image' ? 'image' : 'text',
        text: text
          .replace(/<p\b[^>]*>/gi, '')
          .replace(/<\/p>/gi, '\n')
          .trimEnd(),
        assetRef: item['type'] === 'image' && typeof item['src'] === 'string' ? item['src'] : null,
        left: number('left', 0),
        top: number('top', 0),
        width: number('width', 200),
        height: number('height', 100),
        style: {
          fontSize: Number(css.match(/font-size:\s*(\d+)px/)?.[1] ?? 20),
          color: css.match(/color:\s*(#[0-9a-f]{6})/i)?.[1] ?? '#232323',
          bold: /font-weight:\s*(700|bold)/.test(css),
          italic: /font-style:\s*italic/.test(css),
          align: align === 'center' || align === 'right' ? align : 'left',
        },
      },
    ];
  });
};

/** 只投影「题干 + 选项文字」：`answer`/`analysis`/`points` 在类型层面就未被读取。 */
const readQuizProjection = (
  content: unknown,
): { questionId: string | null; stem: string; options: string[] }[] => {
  const questions = (content as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const rawOptions = Array.isArray(item['options']) ? item['options'] : [];
      const options = rawOptions
        .filter(
          (option): option is Record<string, unknown> =>
            Boolean(option) && typeof option === 'object',
        )
        .map((option) => String(option['label'] ?? option['value'] ?? ''))
        .filter((option) => option.length > 0);
      return {
        questionId: typeof item['id'] === 'string' ? item['id'] : null,
        stem: String(item['question'] ?? ''),
        options,
      };
    })
    .filter((question) => question.stem.length > 0 || question.options.length > 0);
};

const documentStructures = (
  scene: PlanSceneDto,
  context: SlideContext,
  nextShapeId: () => string,
): PptxShape[] => {
  const canvas = (context.documentContent as { canvas?: { elements?: unknown } } | undefined)
    ?.canvas;
  const elements = Array.isArray(canvas?.elements) ? canvas!.elements : [];
  const shapes: PptxShape[] = [];
  const boxOf = (element: Record<string, unknown>) =>
    frameOfElement(
      {
        left: Number(element['left'] ?? 0),
        top: Number(element['top'] ?? 0),
        width: Number(element['width'] ?? 200),
        height: Number(element['height'] ?? 120),
      },
      context,
    );

  for (const raw of elements) {
    if (!raw || typeof raw !== 'object') continue;
    const element = raw as Record<string, unknown>;
    const sourceElementId = typeof element['id'] === 'string' ? element['id'] : scene.sceneId;
    const frame = boxOf(element);
    const type = element['type'];

    if (type === 'chart') {
      const categories = Array.isArray(element['categories'])
        ? element['categories'].map((item) => String(item))
        : [];
      const rawSeries = Array.isArray(element['series']) ? (element['series'] as unknown[]) : [];
      const series = rawSeries
        .filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
        )
        .map((item) => ({
          name: String(item['name'] ?? ''),
          values: (Array.isArray(item['values']) ? (item['values'] as unknown[]) : [])
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value)),
        }))
        .filter((item) => item.values.length > 0);
      if (categories.length > 0 && series.length > 0) {
        const chartType = element['chartType'];
        shapes.push({
          kind: 'chart',
          shapeId: nextShapeId(),
          sceneId: scene.sceneId,
          sourceElementId,
          editable: true,
          frame,
          chartType: chartType === 'line' || chartType === 'pie' ? chartType : 'bar',
          categories,
          series,
        });
      }
      continue;
    }

    if (type === 'table') {
      const rows = Array.isArray(element['rows'])
        ? (element['rows'] as unknown[])
            .map((row) =>
              Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [String(row ?? '')],
            )
            .filter((row) => row.some((cell) => cell.length > 0))
        : [];
      if (rows.length > 0) {
        shapes.push({
          kind: 'table',
          shapeId: nextShapeId(),
          sceneId: scene.sceneId,
          sourceElementId,
          editable: true,
          frame,
          rows,
          firstRowIsHeader: element['header'] !== false,
        });
      }
      continue;
    }

    if (type === 'diagram') {
      const nodes = Array.isArray(element['nodes']) ? (element['nodes'] as unknown[]) : [];
      const edges = Array.isArray(element['edges']) ? (element['edges'] as unknown[]) : [];
      const centers = new Map<string, { xEmu: number; yEmu: number }>();
      nodes.forEach((raw2, nodeIndex) => {
        if (!raw2 || typeof raw2 !== 'object') return;
        const node = raw2 as Record<string, unknown>;
        const x = Number(node['x'] ?? 0);
        const y = Number(node['y'] ?? 0);
        const center = { xEmu: Math.round(x * context.scale), yEmu: Math.round(y * context.scale) };
        centers.set(String(node['id'] ?? nodeIndex), center);
        shapes.push({
          kind: 'text',
          shapeId: nextShapeId(),
          sceneId: scene.sceneId,
          sourceElementId,
          editable: true,
          textRole: 'label',
          frame: {
            leftEmu: center.xEmu,
            topEmu: center.yEmu,
            widthEmu: Math.max(1, Math.round(160 * context.scale)),
            heightEmu: Math.max(1, Math.round(48 * context.scale)),
          },
          runs: [
            {
              text: String(node['label'] ?? ''),
              bold: false,
              italic: false,
              underline: false,
              baseline: 'normal',
              sizeCentipoints: pptxCentipointsFromPixels(16, context.scale),
              color: context.theme.fontColor,
              fontName: context.theme.fontName,
              formula: null,
            },
          ],
          alignment: 'center',
          lineHeight: 1.5,
        });
      });
      edges.forEach((raw2) => {
        if (!raw2 || typeof raw2 !== 'object') return;
        const edge = raw2 as Record<string, unknown>;
        const start = centers.get(String(edge['from']));
        const end = centers.get(String(edge['to']));
        if (!start || !end) return;
        shapes.push({
          kind: 'line',
          shapeId: nextShapeId(),
          sceneId: scene.sceneId,
          sourceElementId,
          editable: true,
          startEmu: start,
          endEmu: end,
          widthEmu: Math.max(1, Math.round(2 * context.scale)),
        });
      });
    }
  }
  return shapes;
};

const frameOfElement = (
  box: { left: number; top: number; width: number; height: number },
  context: SlideContext,
): PptxFrame => {
  const leftEmu = Math.max(
    0,
    Math.round(Math.min(Math.max(box.left, 0), context.viewportSize) * context.scale),
  );
  const topEmu = Math.max(
    0,
    Math.round(Math.min(Math.max(box.top, 0), context.viewportHeight) * context.scale),
  );
  return {
    leftEmu,
    topEmu,
    widthEmu: Math.max(
      1,
      Math.min(Math.round(box.width * context.scale), context.slideSize.widthEmu - leftEmu),
    ),
    heightEmu: Math.max(
      1,
      Math.min(Math.round(box.height * context.scale), context.slideSize.heightEmu - topEmu),
    ),
  };
};

/** 从计划里收集需要可移植内联的图片引用（供接入侧按 assetRef 取字节并构造 `media`）。 */
export const collectPptxAssetRefs = (scenes: readonly PlanSceneDto[]): string[] => {
  const refs = new Set<string>();
  for (const scene of scenes) {
    for (const element of scene.elements) {
      if (element.kind !== 'image') continue;
      const ref = element.assetRef;
      if (typeof ref === 'string' && ref.length > 0) refs.add(ref);
    }
  }
  return [...refs].sort((left, right) => left.localeCompare(right));
};

/** 结构模型的确定性内容摘要（不含时间与自身摘要）：同一计划每次导出得到同一 digest。 */
export const pptxDeckDigest = (deck: Omit<PptxDeck, 'digest'>): string =>
  fingerprintOf(canonicalJson({ ...deck, digest: '', generatedAt: '' }));

/**
 * 冻结场景计划 → 可编辑 PPTX 结构。
 *
 * 场景集合与顺序逐条映射为幻灯片，不静默补场景、不丢场景；`identity.planDigest` 给定时必须与
 * 传入场景的计划内容摘要一致（绑定「导出的确实是这一版」）。
 */
export const buildPptxDeck = (input: BuildPptxDeckInput): PptxDeck => {
  const { identity, scenes } = input;
  if (scenes.length === 0) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'pptx_plan_has_no_scenes' });
  }
  if (identity.planDigest !== null) {
    const computed = scenePlanDigest({
      lessonId: identity.lessonId,
      lessonVersion: identity.lessonVersion,
      bundleId: identity.bundleId,
      scenes,
    });
    if (computed !== identity.planDigest) {
      throw new StudyError('VERSION_CONFLICT', {
        reason: 'pptx_plan_digest_mismatch',
        expected: identity.planDigest,
        actual: computed,
      });
    }
  }
  const options = input.options ?? {};
  const slideSize = PPTX_SLIDE_SIZES[options.slideSize ?? '16:9'];
  const theme: PptxTheme = { ...DEFAULT_THEME, ...(options.theme ?? {}) };
  const viewportSize = options.viewportSize ?? DEFAULT_VIEWPORT_SIZE;
  const viewportRatio = options.viewportRatio ?? DEFAULT_VIEWPORT_RATIO;
  if (!Number.isFinite(viewportSize) || viewportSize <= 0) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'pptx_viewport_size_invalid' });
  }
  if (!Number.isFinite(viewportRatio) || viewportRatio <= 0 || viewportRatio > 4) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'pptx_viewport_ratio_invalid' });
  }
  const context: SlideContext = {
    scale: pptxScaleOf({ viewportSize, viewportRatio, slideSize }),
    slideSize,
    theme,
    viewportSize,
    viewportHeight: viewportSize * viewportRatio,
    media: options.media ?? new Map<string, PptxMediaFact>(),
    documentContent: null,
    issues: [],
  };
  const documentSceneContent = options.documentSceneContent ?? new Map<string, unknown>();

  const slides = scenes.map((scene, index) =>
    buildSlide(
      scene,
      index,
      documentSceneContent.has(scene.sceneId)
        ? { ...context, documentContent: documentSceneContent.get(scene.sceneId) }
        : context,
    ),
  );

  const deck: PptxDeck = {
    deckVersion: PPTX_EXPORT_VERSION,
    format: 'pptx',
    generatedAt: options.generatedAt ?? '',
    identity,
    slideSize,
    theme,
    canvas: { viewportSize, viewportRatio },
    slides,
    issues: context.issues,
    digest: '',
  };
  return { ...deck, digest: pptxDeckDigest(deck) };
};

/**
 * 写盘前的可编辑性把关（「不把课件整体栅格化」这条验收的实现处）。违规项：
 * - `empty_slide`：场景一个形状都没有（静默丢课件）；
 * - `no_editable_content`：幻灯片里没有任何可编辑文字/公式/图表/表格形状；
 * - `dropped_elements` / `element_unrepresented`：有被丢掉的源元素，或形状数少于源元素数；
 * - `content_loss`：可编辑文字少于源文字；
 * - `whole_slide_raster`：没有文字/公式形状却有一张铺满版的图片（典型整体栅格化伪装）；
 * - `unportable_reference` / `unverifiable_media`：图片引用不可移植，或缺字节摘要无法复验；
 * - `missing_source_binding` / `empty_run`：正文形状没有回指计划元素，或出现空运行段；
 * - `schema_open`：产物结构里出现未登记字段（判分依据风险）。
 */
export const pptxDeckEditabilityViolations = (deck: PptxDeck): string[] => {
  const violations: string[] = [];
  for (const slide of deck.slides) {
    const hasTextLike = slide.shapes.some(
      (shape) =>
        shape.kind === 'text' ||
        shape.kind === 'formula' ||
        shape.kind === 'chart' ||
        shape.kind === 'table',
    );
    if (slide.shapes.length === 0) {
      violations.push(`empty_slide:${slide.sceneId}`);
      continue;
    }
    if (!hasTextLike) violations.push(`no_editable_content:${slide.sceneId}`);
    if (slide.fidelity.droppedElements.length > 0) {
      violations.push(
        `dropped_elements:${slide.sceneId}:${slide.fidelity.droppedElements.join(',')}`,
      );
    }
    if (slide.fidelity.shapeElements < slide.fidelity.sourceElements) {
      violations.push(`element_unrepresented:${slide.sceneId}`);
    }
    if (slide.fidelity.shapeChars < slide.fidelity.sourceChars) {
      violations.push(`content_loss:${slide.sceneId}`);
    }
    const fullBleed = slide.shapes.find(
      (shape) =>
        shape.kind === 'picture' &&
        shape.frame.widthEmu >= deck.slideSize.widthEmu * 0.98 &&
        shape.frame.heightEmu >= deck.slideSize.heightEmu * 0.98,
    );
    if (fullBleed && !hasTextLike) violations.push(`whole_slide_raster:${slide.sceneId}`);
    for (const shape of slide.shapes) {
      if (shape.kind === 'text') {
        if (
          shape.textRole !== 'title' &&
          shape.textRole !== 'note' &&
          shape.sourceElementId === null
        ) {
          violations.push(`missing_source_binding:${slide.sceneId}:${shape.shapeId}`);
        }
        if (shape.runs.length === 0 || shape.runs.some((run) => run.text.length === 0)) {
          violations.push(`empty_run:${slide.sceneId}:${shape.shapeId}`);
        }
      }
      if (shape.kind === 'picture') {
        const kind = classifyMediaReference(shape.reference);
        if (kind !== 'package-relative' && kind !== 'inline-data') {
          violations.push(`unportable_reference:${slide.sceneId}:${shape.reference}`);
        }
        if (kind === 'package-relative' && shape.sha256 === null) {
          violations.push(`unverifiable_media:${slide.sceneId}:${shape.shapeId}`);
        }
      }
    }
  }
  for (const path of pptxDeckSchemaViolations(deck)) violations.push(`schema_open:${path}`);
  return violations;
};

export const assertPptxDeckEditable = (deck: PptxDeck): void => {
  const violations = pptxDeckEditabilityViolations(deck);
  if (violations.length > 0) {
    throw new StudyError('INVALID_ARGUMENT', {
      reason: 'pptx_deck_not_editable',
      violations: violations.slice(0, 20),
    });
  }
};
