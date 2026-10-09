/**
 * 互动保活与可支持的快照恢复（OMA-045）。
 *
 * 互动组件（受控 iframe）的**临时现场**（如滑块取值）会在离开场景或重启后丢失。这里提供一条受控
 * 的「保活快照」通道：
 * - 组件把自己的**临时状态**作为快照上报，服务端按 (项目, stage, 场景, 组件版本, 本人) 分区持久化；
 * - 重新进入场景时，只有**组件版本一致**才恢复快照；版本不一致时**明确重置**为初始现场；
 * - 无论恢复还是重置，**本人已提交的记录（作答/互动提交/白板动作）始终保留**，不因现场重置而删除。
 *
 * 快照是**非权威现场**：不参与判分、不更新掌握、不进入正式记录；它只让可支持的组件少丢一次现场。
 */

import { z } from 'zod';
import { projectScopeSchema } from './api';

const id = z.string().trim().min(1).max(200);

/** 快照内容：JSON 对象，键与值都受严格边界约束，避免任意大对象落库。 */
export const interactiveSnapshotDataSchema = z.record(
  z.string().min(1).max(120),
  z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]),
);
export type InteractiveSnapshotData = z.infer<typeof interactiveSnapshotDataSchema>;

export const interactiveSnapshotSchema = z
  .object({
    stageId: id,
    sceneId: id,
    /** 组件版本：定义/HTML 一变，旧现场不再适用，必须重置。 */
    widgetVersion: z.string().min(1).max(120),
    data: interactiveSnapshotDataSchema,
    updatedAt: z.string(),
  })
  .strict();
export type InteractiveSnapshotDto = z.infer<typeof interactiveSnapshotSchema>;

/** 读取结果：`restored` 为真时 `snapshot` 可用；否则要求组件按初始现场重置。 */
export const interactiveSnapshotStateSchema = z
  .object({
    /** 当前组件版本（服务端据当前文档计算）。 */
    widgetVersion: z.string().min(1).max(120),
    restored: z.boolean(),
    snapshot: interactiveSnapshotSchema.nullable(),
    /** 未恢复时的可读原因（版本不符、无快照等）。 */
    reason: z.enum(['none', 'widget_version_changed', 'restored']),
  })
  .strict();
export type InteractiveSnapshotStateDto = z.infer<typeof interactiveSnapshotStateSchema>;

/** 上报/读取快照命令。 */
export const interactiveSnapshotCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('read'),
      scope: projectScopeSchema,
      stageId: id,
      sceneId: id,
    })
    .strict(),
  z
    .object({
      operation: z.literal('write'),
      scope: projectScopeSchema,
      stageId: id,
      sceneId: id,
      data: interactiveSnapshotDataSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('clear'),
      scope: projectScopeSchema,
      stageId: id,
      sceneId: id,
    })
    .strict(),
]);
export type InteractiveSnapshotCommand = z.infer<typeof interactiveSnapshotCommandSchema>;
