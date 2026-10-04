import { z } from 'zod';
import { RECORD_SCOPE } from '../status';
import { projectScopeSchema } from './project';

// —— 课堂 ——

/**
 * 场景来源绑定：渲染层据此显示「来源可定位」并把测验提交绑到真实题目身份。
 * 题目 ID 由服务端派生，请求方不能自带一个来路不明的 questionId。
 */
export const classroomSceneBindingSchema = z.object({
  sceneId: z.string().min(1),
  sceneType: z.enum(['slide', 'quiz', 'interactive', 'pbl']),
  knowledgeIds: z.array(z.string().min(1)).min(1),
  questionId: z.string().min(1).nullable(),
  reviewedBy: z.string().min(1),
  reviewNote: z.string(),
});
export type ClassroomSceneBinding = z.infer<typeof classroomSceneBindingSchema>;

// Explicit personal observations; these never represent grading or mastery.
export const interactionDirectionSchema = z.enum(['increasing', 'decreasing', 'constant']);
const interactionFields = {
  stageId: z.string().min(1).max(200),
  sceneId: z.string().min(1).max(200),
  a: z.number().min(-3).max(3).refine((value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-9, '参数须为 0.1 的整数倍'),
  prediction: interactionDirectionSchema,
  explanation: z.string().max(2000),
};
export const interactionSubmitSchema = z.object({
  scope: projectScopeSchema.strict(),
  ...interactionFields,
}).strict();
export type InteractionSubmitInput = z.infer<typeof interactionSubmitSchema>;
export const interactionPayloadSchema = z.object({
  payloadVersion: z.literal(1),
  projectId: z.string().min(1),
  documentDigest: z.string().min(1),
  actorType: z.literal('human_learner'),
  recordScope: z.literal('demo'),
  ...interactionFields,
  direction: interactionDirectionSchema,
}).strict();
export const interactionSubmissionSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  payload: interactionPayloadSchema,
}).strict();
export type InteractionSubmissionDto = z.infer<typeof interactionSubmissionSchema>;
export const interactionStateSchema = z.object({
  lastSubmission: interactionSubmissionSchema.nullable(),
  count: z.number().int().nonnegative(),
  deduplicated: z.boolean(),
}).strict();
export type InteractionStateDto = z.infer<typeof interactionStateSchema>;

/** 资源回收报告里的一条未绑定资源：只暴露身份与占用，不含字节与元数据。 */
export const classroomAssetInfoSchema = z.object({
  recordScope: z.enum(RECORD_SCOPE),
  assetId: z.string(),
  mediaType: z.string(),
  sha256: z.string(),
  revision: z.number().int().positive(),
  byteLength: z.number().int().nonnegative(),
});
export type ClassroomAssetInfoDto = z.infer<typeof classroomAssetInfoSchema>;

export const assetReclaimReportSchema = z.object({
  /** 当前无课件绑定的资源，可回收候选。 */
  unbound: z.array(classroomAssetInfoSchema),
  unboundBytes: z.number().int().nonnegative(),
  /** 项目内全部课堂资源占用与上限，界面据此说明回收能释放多少。 */
  usedBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
});
export type AssetReclaimReportDto = z.infer<typeof assetReclaimReportSchema>;

/** 回收命令：候选必须来自同一次报告，服务端会重新确认绑定状态。 */
export const assetReclaimSchema = z.object({
  scope: projectScopeSchema,
  assetIds: z.array(z.string().min(1)).min(1).max(200),
});
export type AssetReclaimInput = z.infer<typeof assetReclaimSchema>;

export const assetReclaimResultSchema = z.object({
  reclaimed: z.array(z.string()),
  freedBytes: z.number().int().nonnegative(),
  /** 本次之后剩余的候选数；重复提交同一批会显示已回收为 0 而不是报错。 */
  remainingUnbound: z.number().int().nonnegative(),
});
export type AssetReclaimResultDto = z.infer<typeof assetReclaimResultSchema>;
