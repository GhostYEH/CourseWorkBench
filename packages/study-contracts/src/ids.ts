/**
 * 共享标识类型。
 *
 * 全部为字符串别名（branded type），避免在调用点把不同种类的 ID 互相传递。
 * 命名遵循《规划书》第 7 节的数据模型。
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProjectId = Brand<string, 'ProjectId'>;
export type RunId = Brand<string, 'RunId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type MaterialId = Brand<string, 'MaterialId'>;
export type SegmentId = Brand<string, 'SegmentId'>;
export type KnowledgeId = Brand<string, 'KnowledgeId'>;
export type ProposalId = Brand<string, 'ProposalId'>;
export type ReviewId = Brand<string, 'ReviewId'>;
export type QuestionId = Brand<string, 'QuestionId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type StepId = Brand<string, 'StepId'>;
export type LessonId = Brand<string, 'LessonId'>;
export type StageId = Brand<string, 'StageId'>;
export type LearnerKey = Brand<string, 'LearnerKey'>;

/** 项目打开代次：同路径重开也必须重新分配，不能用目录字符串判断身份。 */
export type ProjectGeneration = number;

export const asId = <T extends string>(value: string): T => value as T;

/**
 * `newId` 只产生小写字母、数字与下划线。标识要进入文件路径时必须先按此复验，
 * 不能把任意调用方字符串直接拼成路径。
 */
export const GENERATED_ID_PATTERN = /^[a-z0-9_]{1,64}$/;

/** 段落编号形如 `S003`。 */
export const SEGMENT_ID_PATTERN = /^S\d{3,}$/;

/** 考纲条目内「必要要素」的稳定编号，形如 `def-1`；条目内唯一，映射按它计数。 */
export const SYLLABUS_REQUIREMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * 生成稳定 ID。使用项目前缀 + 随机段，避免依赖数据库自增暴露顺序。
 * 不使用 crypto.randomUUID 以保持 Node/浏览器/测试环境一致。
 */
export const newId = <T extends string>(prefix: string): T => {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}${random}` as T;
};
