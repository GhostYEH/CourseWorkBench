/**
 * 正式互动的纯函数（VIS-01/02、ROOM-01）。
 *
 * 这些派生规则原先只存在于应用层，ROOM 公共投影需要同一套规则；放在领域层
 * 让两边复用同一份实现，避免「本地看到的公开定义」和「共享出去的公开定义」不一致。
 * 这一层不做 IO，也不知道数据库与 HTTP。
 */

import { createHash } from 'node:crypto';
import type { FormalInteractionDefinitionDto, FormalInteractionBindingDto } from '@sew/study-contracts';

/** 定义与记录的稳定摘要。使用 JSON.stringify 的字段顺序，写入方必须先构造对象再摘要。 */
export const formalInteractionHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 场景编号：由互动定义编号派生，定义与场景一一对应。 */
export const formalInteractionSceneId = (definitionId: string): string =>
  `scene_formal_interaction_${definitionId}`;

/** 冻结定义的存放分区（按课程版本）。 */
export const formalInteractionDefinitionSessionId = (lessonId: string, version: number): string =>
  `sew-formal-interaction-definition-v1-${formalInteractionHash([lessonId, version])}`;

/** 本人互动观察的存放分区（按项目 + 本人 UID + 绑定）。 */
export const formalInteractionObservationSessionId = (
  projectId: string,
  uid: string,
  binding: FormalInteractionBindingDto,
): string => `sew-formal-interaction-observation-v1-${formalInteractionHash([projectId, uid, binding])}`;

/**
 * 公开投影：去掉关系正确目标 `to`。
 *
 * 参数实验本来就只公开范围与步长，原样返回。概念关系则必须去掉 `to`——
 * 否则把定义下发出去就等于把答案一起给了对方，互动也就不再是互动。
 */
export const publicFormalInteractionDefinition = (
  definition: FormalInteractionDefinitionDto,
): FormalInteractionDefinitionDto | {
  id: string; title: string; statementIds: string[]; kind: 'concept_relation';
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ id: string; from: string; label: string }>;
} => definition.kind === 'parameter'
  ? definition
  : {
    ...definition,
    edges: definition.edges.map(({ id, from, label }) => ({ id, from, label })),
  };
