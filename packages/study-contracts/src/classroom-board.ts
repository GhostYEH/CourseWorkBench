import { z } from 'zod';
import { projectScopeSchema } from './api';

const id = z.string().trim().min(1).max(200);
/** Text is rendered as text, never HTML; markup and executable URL payloads are refused. */
const text = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .refine(
    (value) =>
      !/<\s*\/?\s*[a-z][a-z0-9-]*(?:\s[^<>]*|\/?)>|<!--|javascript\s*:|data\s*:\s*text\/html/i.test(
        value,
      ),
    '白板只接受文字，不接受 HTML 或脚本',
  );
/**
 * 公式的数学排版源码（KaTeX）。
 *
 * 渲染端固定用 `trust: false`，KaTeX 不会把 `\href`/`\url`/`\includegraphics`/`\html*`
 * 变成真实链接或 HTML；这里的黑名单是纵深防御，专门挡文件读写、宏定义与 HTML 原语。
 * 刻意不套用上面那条 HTML 标签规则：数学里出现 `a < b > c` 是合法的，不该被误杀。
 */
const LATEX_FORBIDDEN =
  /\\(?:href|url|includegraphics|html|htmlClass|htmlId|htmlStyle|htmlData|def|edef|gdef|xdef|newcommand|renewcommand|providecommand|input|include|includeonly|write|read|openout|closeout|catcode|csname|endcsname|special|usepackage|RequirePackage|documentclass|lstinputlisting|verbatiminput|directlua|latelua|immediate)\b|javascript\s*:|data\s*:\s*text\/html/i;
const latex = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (value) => !LATEX_FORBIDDEN.test(value),
    '公式只接受数学排版，不接受文件、宏定义或脚本指令',
  );
const node = z
  .object({
    id,
    label: text,
    x: z.number().finite().min(0).max(1000),
    y: z.number().finite().min(0).max(1000),
  })
  .strict();
const edge = z.object({ from: id, to: id, label: text.optional() }).strict();
const diagram = z
  .object({
    kind: z.literal('diagram'),
    nodes: z.array(node).min(1).max(24),
    edges: z.array(edge).max(48),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.nodes.map((item) => item.id));
    if (
      ids.size !== value.nodes.length ||
      value.edges.some((item) => !ids.has(item.from) || !ids.has(item.to))
    ) {
      ctx.addIssue({ code: 'custom', message: '简图节点必须唯一，连接必须引用已有节点' });
    }
  });
export const classroomBoardContentSchema = z.union([
  z.object({ kind: z.literal('text'), text }).strict(),
  /**
   * 公式：`text` 是可访问的纯文本形式（读屏与降级用），`latex` 是排版源码。
   * `latex` 为 null 时只显示 `text`，不会渲染失败就变成空白。
   */
  z.object({ kind: z.literal('formula'), text, latex: latex.nullable().default(null) }).strict(),
  diagram,
  z.object({ kind: z.literal('highlight'), statementId: id, text }).strict(),
  /**
   * 教师聚焦：把注意力引到当前场景的某个**已存在**元素上，附一句说明。
   * 元素必须真实存在于该版本的冻结课件里（由服务端核对），不能凭空指一个不存在的对象。
   */
  z.object({ kind: z.literal('focus'), elementId: id, text }).strict(),
  /**
   * 激光笔：与聚焦同为「指向当前场景的真实元素」，但语义是**临时的指引笔迹**，
   * 不改变该元素的呈现（不画高亮框、不压暗其余内容）。元素同样由服务端核对存在性。
   */
  z.object({ kind: z.literal('laser'), elementId: id, text }).strict(),
]);
export const classroomBoardBindingSchema = z
  .object({
    projectId: id,
    lessonId: id,
    lessonVersion: z.number().int().positive(),
    sceneId: id,
    statementIds: z
      .array(id)
      .min(1)
      .max(40)
      .refine((ids) => new Set(ids).size === ids.length, '陈述不得重复'),
  })
  .strict();
export const classroomBoardItemSchema = classroomBoardBindingSchema
  .extend({
    itemId: id,
    version: z.number().int().positive(),
    status: z.enum(['draft', 'approved', 'rejected']),
    content: classroomBoardContentSchema,
    reviewNote: z.string().max(4000),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export const classroomBoardEffectSchema = z
  .object({
    projectId: id,
    sessionId: id,
    seq: z.number().int().positive(),
    item: classroomBoardItemSchema,
    actor: z.literal('teacher'),
    at: z.string(),
  })
  .strict()
  .refine(
    (effect) => effect.item.status === 'approved' && effect.item.projectId === effect.projectId,
    '只有审核通过且项目相符的动作可成为白板效果',
  );
export const classroomBoardStateSchema = z
  .object({
    sessionId: id,
    seq: z.number().int().nonnegative(),
    items: z.array(classroomBoardItemSchema),
    effects: z.array(classroomBoardEffectSchema),
  })
  .strict();
export const classroomBoardItemResultSchema = z
  .object({ item: classroomBoardItemSchema, deduplicated: z.boolean() })
  .strict();
export const classroomBoardPlayResultSchema = z
  .object({ effect: classroomBoardEffectSchema, deduplicated: z.boolean() })
  .strict();
const base = { scope: projectScopeSchema.strict(), requestId: id };
export const classroomBoardCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...base,
      action: z.literal('create'),
      lessonId: id,
      lessonVersion: z.number().int().positive(),
      sceneId: id,
      statementIds: classroomBoardBindingSchema.shape.statementIds,
      content: classroomBoardContentSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('review'),
      itemId: id,
      expectedVersion: z.number().int().positive(),
      decision: z.enum(['approved', 'rejected']),
      semanticReviewed: z.literal(true),
      note: text,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('play'),
      sessionId: id,
      itemId: id,
      expectedVersion: z.number().int().positive(),
      expectedSeq: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type ClassroomBoardBindingDto = z.infer<typeof classroomBoardBindingSchema>;
export type ClassroomBoardContentDto = z.infer<typeof classroomBoardContentSchema>;
export type ClassroomBoardItemDto = z.infer<typeof classroomBoardItemSchema>;
export type ClassroomBoardEffectDto = z.infer<typeof classroomBoardEffectSchema>;
export type ClassroomBoardStateDto = z.infer<typeof classroomBoardStateSchema>;
export type ClassroomBoardCommand = z.infer<typeof classroomBoardCommandSchema>;
