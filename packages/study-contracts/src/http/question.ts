import { z } from 'zod';
import { questionAssessmentSchema } from '../assessment';
import { questionAssessmentMetadataSchema } from '../assessment';
import { QUESTION_ORIGIN } from '../status';
import { RECORD_SCOPE } from '../status';
import { projectScopeSchema } from './project';

// —— 题目身份 ——

export const questionCreateSchema = z.object({
  assessment: questionAssessmentSchema.nullable().default(null),
  scope: projectScopeSchema,
  stem: z.string().min(2),
  answer: z.string().default(''),
  solution: z.string().default(''),
  knowledgeIds: z.array(z.string()).min(1),
  /** 请求方声明的身份只是请求；服务端按可信记录裁定。 */
  requestedOrigin: z.enum(QUESTION_ORIGIN),
  /**
   * 原题/改写必须提供可信出处记录。
   *
   * 注意：这里**不含** `materialVerifiedAsExam` 之类可由请求自报的字段。
   * 「材料已被人工核实为考试真题」属于服务端权威事实，只能由授权审核操作写入，
   * 再由服务端按 `(materialId, revision)` 派生，请求方无法自我授予真题身份。
   */
  originRecord: z
    .object({
      materialId: z.string(),
      revision: z.number().int().positive(),
      questionNumber: z.string().max(60).default(''),
      /** 改写题必须绑定原题并记录修改内容。 */
      rewrittenFrom: z.string().nullable().default(null),
      rewriteNote: z.string().max(500).default(''),
    })
    .nullable()
    .default(null),
});
export type QuestionCreateInput = z.infer<typeof questionCreateSchema>;

/**
 * 题目列表项：按使用场景最小化字段，**不含**标准答案与解析。
 * 未授权的列表响应与客户端缓存都不应出现答案。
 */
export const questionListItemSchema = z.object({
  assessment: questionAssessmentMetadataSchema.nullable().default(null),
  questionId: z.string(),
  stem: z.string(),
  knowledgeIds: z.array(z.string()),
  /** 服务端裁定后的身份。 */
  origin: z.enum(QUESTION_ORIGIN),
  /** 面向学习者展示的出处文字，由模板统一渲染。 */
  originLabel: z.string(),
  originDetail: z.string().nullable(),
  recordScope: z.enum(RECORD_SCOPE),
  revision: z.number().int().positive(),
});
export type QuestionListItemDto = z.infer<typeof questionListItemSchema>;

/**
 * 题目详情：仅在授权判分路径或明确需要的详情流程中返回标准答案与解析。
 * 列表、缓存与课堂默认视图不得使用该 DTO。
 */
export const questionSchema = questionListItemSchema.extend({
  assessment: questionAssessmentSchema.nullable().default(null),
  answer: z.string(),
  solution: z.string(),
});
export type QuestionDto = z.infer<typeof questionSchema>;

/** 需要答案的入口必须显式声明；服务端据此决定是否返回 `questionSchema`。 */
export const questionDetailQuerySchema = z.object({
  // 注意：不能用 z.coerce.boolean()——它对任意非空字符串都返回 true，
  // 会让 `?includeAnswer=false` 意外泄露答案。这里只接受字面量 'true'。
  includeAnswer: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export type QuestionDetailQuery = z.infer<typeof questionDetailQuerySchema>;
