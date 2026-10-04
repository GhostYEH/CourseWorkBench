/**
 * 四层恢复合同（《规划书》6.7，RESUME-01）。
 *
 * 恢复不是「把界面刷回去」：每一层在交还给使用前都要先复验自己依赖的权威事实，
 * 复验不过就明确阻断或重置，绝不静默降级成一节内容和之前不一样的课。
 *
 * 四层的责任边界（与规划书表格逐行对应）：
 * 1. `document`    课件文档：stage/scene、发布版本、来源映射与资产引用；
 * 2. `board`       讨论/白板：已提交发言、动作、序号与等待/执行状态；
 * 3. `attempt`     本人作答：草稿、提交、题目/规则版本、判分与本人身份；
 * 4. `interaction` 互动现场：组件类型、版本、获准 JSON 快照与提交记录。
 */

import { z } from 'zod';
import { CLASSROOM_SESSION_STATUS } from './teaching';

export const RECOVERY_LAYERS = ['document', 'board', 'attempt', 'interaction'] as const;
export type RecoveryLayer = (typeof RECOVERY_LAYERS)[number];

export const RECOVERY_LAYER_LABEL: Record<RecoveryLayer, string> = {
  document: '课堂文档',
  board: '讨论与白板',
  attempt: '本人作答',
  interaction: '互动现场',
};

/**
 * 单层结论。
 *
 * `reset` 与 `blocked` 的区别很重要：`reset` 表示这一层的临时现场可以安全丢弃
 * （例如 iframe 内存状态），已提交的本人记录仍然保留；`blocked` 表示连权威事实
 * 都对不上（例如来源失效或摘要不符），此时不能继续上这一节课。
 */
export const RECOVERY_STATUS = ['restored', 'waiting', 'reset', 'blocked'] as const;
export type RecoveryStatus = (typeof RECOVERY_STATUS)[number];

export const recoveryLayerResultSchema = z.object({
  layer: z.enum(RECOVERY_LAYERS),
  status: z.enum(RECOVERY_STATUS),
  /** 面向用户的一句话结论；界面直接显示，不再二次措辞。 */
  message: z.string().min(1).max(300),
  /** 服务端判定的原因码，用于回归断言与日志；不是给用户看的文案。 */
  reason: z.string().min(1).max(120),
  /** 本次恢复是否触发了外部调用。只读恢复必须恒为 0。 */
  providerCalls: z.literal(0),
  /** 恢复过程中被丢弃的临时状态条目数（草稿、未提交动作）；不包含已提交记录。 */
  discarded: z.number().int().nonnegative(),
  /** 仍然有效、可供界面直接展示的记录数（已提交白板动作、本人作答等）。 */
  preserved: z.number().int().nonnegative(),
}).strict();
export type RecoveryLayerResultDto = z.infer<typeof recoveryLayerResultSchema>;

export const recoveryCheckpointSchema = z.object({
  projectId: z.string().min(1).max(200),
  /** 项目代次：跨代次的检查点一律拒绝，避免把别的项目状态认成自己的。 */
  generation: z.number().int().positive(),
  sessionId: z.string().min(1).max(200),
  uid: z.string().min(1).max(200),
  layers: z.array(recoveryLayerResultSchema).length(4).refine(layers => new Set(layers.map(layer => layer.layer)).size === 4, '恢复必须覆盖四个独立图层'),
  /** 四层全部可用且会话可执行才允许续课；等待、终止或阻断均为 false。 */
  resumable: z.boolean(),
  sessionStatus: z.enum(CLASSROOM_SESSION_STATUS),
  /** waiting 和 terminal 都不能自动续课。 */
  continuation: z.enum(['continue', 'waiting', 'terminal', 'blocked']),
  position: z.object({ stageId: z.string().min(1), sceneId: z.string().min(1), boardSeq: z.number().int().nonnegative().nullable() }).strict(),
  /** 恢复动作自身不发 provider 请求；这里恒为 0，防止将来被误用成重新生成。 */
  providerCalls: z.literal(0),
  checkedAt: z.string().datetime(),
}).strict().superRefine((checkpoint, ctx) => {
  const expected = checkpoint.layers.some(layer => layer.status === 'blocked') ? 'blocked'
    : checkpoint.sessionStatus === 'completed' || checkpoint.sessionStatus === 'cancelled' ? 'terminal'
    : checkpoint.sessionStatus === 'awaiting_learner' || checkpoint.layers.some(layer => layer.status === 'waiting') ? 'waiting' : 'continue';
  if (checkpoint.continuation !== expected || checkpoint.resumable !== (expected === 'continue')) ctx.addIssue({ code: 'custom', path: ['continuation'], message: '恢复门禁与权威状态不一致' });
});
export type RecoveryCheckpointDto = z.infer<typeof recoveryCheckpointSchema>;

export const recoveryQuerySchema = z.object({
  projectId: z.string().min(1),
  generation: z.coerce.number().int().positive(),
  sessionId: z.string().min(1).max(200),
}).strict();
export type RecoveryQueryInput = z.infer<typeof recoveryQuerySchema>;
