/**
 * 正式互动的纯函数（VIS-01/02、ROOM-01）。
 *
 * 这些派生规则原先只存在于应用层，ROOM 公共投影需要同一套规则；放在领域层
 * 让两边复用同一份实现，避免「本地看到的公开定义」和「共享出去的公开定义」不一致。
 * 这一层不做 IO，也不知道数据库与 HTTP。
 */

import { createHash } from 'node:crypto';
import { StudyError } from '@sew/study-contracts';
import type {
  FormalInteractionDefinitionDto,
  FormalInteractionBindingDto,
} from '@sew/study-contracts';

/** 定义与记录的稳定摘要。使用 JSON.stringify 的字段顺序，写入方必须先构造对象再摘要。 */
export const formalInteractionHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 场景编号：由互动定义编号派生，定义与场景一一对应。 */
export const formalInteractionSceneId = (definitionId: string): string =>
  `scene_formal_interaction_${definitionId}`;

/**
 * 参数实验的结果（VIS-01 的「其余参数组件」）。
 *
 * 结果一律由服务端按冻结定义里的 `formula` 计算，客户端不能自报：
 * - `linear`    → a·x + intercept
 * - `quadratic` → a·x² + intercept
 *
 * 未知公式直接拒绝，而不是猜一个结果——否则「预测是否一致」会用一个没核对过的公式判定。
 */
export const parameterResult = (
  formula: 'linear' | 'quadratic',
  input: { a: number; x: number; intercept: number },
): number => {
  if (formula === 'linear') return input.a * input.x + input.intercept;
  if (formula === 'quadratic') return input.a * input.x * input.x + input.intercept;
  throw new StudyError('INVALID_ARGUMENT', { reason: 'unsupported_parameter_formula', formula });
};

/** 冻结定义的存放分区（按课程版本）。 */
export const formalInteractionDefinitionSessionId = (lessonId: string, version: number): string =>
  `sew-formal-interaction-definition-v1-${formalInteractionHash([lessonId, version])}`;

/** 本人互动观察的存放分区（按项目 + 本人 UID + 绑定）。 */
export const formalInteractionObservationSessionId = (
  projectId: string,
  uid: string,
  binding: FormalInteractionBindingDto,
): string =>
  `sew-formal-interaction-observation-v1-${formalInteractionHash([projectId, uid, binding])}`;

/**
 * 公开投影：去掉关系正确目标 `to` 与排序正确顺序 `correctOrder`。
 *
 * 参数实验本来就只公开范围与步长，原样返回。概念关系必须去掉 `to`——否则把定义下发出去
 * 就等于把答案一起给了对方。排序同理：只公开候选条目，正确顺序必须留在服务端，
 * 否则「排序互动」会退化成「照着答案抄一遍」。
 */
export const publicFormalInteractionDefinition = (
  definition: FormalInteractionDefinitionDto,
):
  | FormalInteractionDefinitionDto
  | {
      id: string;
      title: string;
      statementIds: string[];
      kind: 'concept_relation';
      nodes: Array<{ id: string; label: string }>;
      edges: Array<{ id: string; from: string; label: string }>;
    }
  | {
      id: string;
      title: string;
      statementIds: string[];
      kind: 'ordering';
      items: Array<{ id: string; label: string }>;
    } => {
  if (definition.kind === 'parameter') return definition;
  if (definition.kind === 'concept_relation') {
    return {
      ...definition,
      edges: definition.edges.map(({ id, from, label }) => ({ id, from, label })),
    };
  }
  return {
    id: definition.id,
    title: definition.title,
    statementIds: definition.statementIds,
    kind: 'ordering',
    // 候选按与 correctOrder 无关的稳定键呈现，不能直接下发作者输入的答案顺序。
    items: definition.items
      .map(({ id, label }) => ({ id, label }))
      .sort((left, right) =>
        formalInteractionHash([definition.id, left.id, left.label]).localeCompare(
          formalInteractionHash([definition.id, right.id, right.label]),
        ),
      ),
  };
};

/**
 * 本人排序是否与正确顺序一致。
 *
 * 只做机械比较：顺序必须恰好是全部条目的一次排列，且逐位相同才算一致。
 * 与参数/关系一样，这只记录「这次排序对不对」，**不更新掌握状态**。
 */
export const orderingMatches = (
  order: readonly string[],
  correctOrder: readonly string[],
  itemIds: readonly string[],
): boolean | null => {
  if (order.length !== itemIds.length || new Set(order).size !== order.length) return null;
  if (order.some((id) => !itemIds.includes(id))) return null;
  return order.every((id, index) => id === correctOrder[index]);
};
