/**
 * 课堂文档的纯判断（M0 真实课堂基线）。
 *
 * 课堂文档本身沿用 OpenMAIC DSL 的形状，来源绑定与判分权威留在本项目侧表，
 * 因此 DSL 文档里**不能出现服务端答案**：渲染端拿到的测验必须先去答案，
 * 否则浏览器就能凭 `content.answer` 自行判分（违反「浏览器自报高分不进入判分」）。
 *
 * 这里不做 IO，也不依赖 @openmaic/dsl（该包只出现在应用层），保证领域核心零依赖。
 */

import { StudyError } from '@sew/study-contracts';
import { fingerprintOf } from './normalize';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * 稳定序列化：按键名排序，忽略对象属性顺序差异。
 * 非 JSON 安全值（undefined、函数、NaN、循环引用）视为非法输入而不是静默丢字段。
 *
 * 中间对象必须用 `Object.create(null)`：普通对象字面量上 `out['__proto__'] = …`
 * 命中的是 `Object.prototype` 的 setter，`__proto__` 键会被静默丢掉，
 * 于是「带 __proto__ 的改写文档」与「干净文档」得到同一个指纹，
 * 审核课件守卫就被绕过了。空原型下它只是一个普通自有键，会照常参与哈希。
 */
export const canonicalJson = (value: unknown): string => {
  const encode = (input: unknown, path: string): Json => {
    if (input === null) return null;
    if (typeof input === 'string') return input;
    if (typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw new StudyError('INVALID_ARGUMENT', { path, reason: 'non_finite_number' });
      }
      return input;
    }
    if (Array.isArray(input)) return input.map((item, index) => encode(item, `${path}[${index}]`));
    if (typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const out: { [key: string]: Json } = Object.create(null);
      for (const key of keys) {
        const child = record[key];
        if (child === undefined || typeof child === 'function') {
          throw new StudyError('INVALID_ARGUMENT', {
            path: `${path}.${key}`,
            reason: 'not_json_serializable',
          });
        }
        out[key] = encode(child, `${path}.${key}`);
      }
      return out;
    }
    throw new StudyError('INVALID_ARGUMENT', { path, reason: 'not_json_serializable' });
  };
  return JSON.stringify(encode(value, '$'));
};

/** 文档内容指纹：用于确认「写入的就是登记过的审核课件」，不证明语义正确。 */
export const classroomDocumentDigest = (document: unknown): string =>
  fingerprintOf(canonicalJson(document));

export type DslVersionState = 'unversioned' | 'current' | 'legacy' | 'future';

const parseVersion = (value: string): number[] | null => {
  const parts = value.trim().split('.');
  if (parts.length === 0 || parts.length > 3) return null;
  const nums = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
};

const compareVersions = (a: number[], b: number[]): number => {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
};

/**
 * 判定文档声明的 DSL 版本相对当前支持版本的位置。
 * `future` 必须显式拒绝：旧应用不能猜测新形状，也不能把它降级写入。
 */
export const dslVersionState = (declared: unknown, supported: string): DslVersionState => {
  if (declared === undefined || declared === null || declared === '') return 'unversioned';
  if (typeof declared !== 'string') return 'future';
  const parsed = parseVersion(declared);
  const current = parseVersion(supported);
  if (!parsed || !current) return 'future';
  const order = compareVersions(parsed, current);
  if (order === 0) return 'current';
  return order > 0 ? 'future' : 'legacy';
};

export interface StrippedQuizScene {
  sceneId: string;
  questionIds: string[];
}

/**
 * 移除测验内容里的判分依据（答案、解析、给分点）。
 * 判分只能由服务依据题目权威记录完成，因此渲染文档不含答案。
 */
export const stripQuizAnswers = (
  document: unknown,
): { document: unknown; stripped: StrippedQuizScene[] } => {
  if (!document || typeof document !== 'object') {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'document_not_object' });
  }
  const scenes = (document as { scenes?: unknown }).scenes;
  if (!Array.isArray(scenes)) {
    throw new StudyError('INVALID_ARGUMENT', { reason: 'document_scenes_missing' });
  }
  const stripped: StrippedQuizScene[] = [];
  const next = scenes.map((scene) => {
    if (!scene || typeof scene !== 'object') return scene;
    const record = scene as Record<string, unknown>;
    if (record['type'] !== 'quiz') return scene;
    const content = record['content'] as Record<string, unknown> | undefined;
    const questions = content?.['questions'];
    if (!Array.isArray(questions)) return scene;
    const ids: string[] = [];
    const safeQuestions = questions.map((question) => {
      if (!question || typeof question !== 'object') return question;
      const item = question as Record<string, unknown>;
      const { answer: _answer, analysis: _analysis, points: _points, ...rest } = item;
      if (typeof rest['id'] === 'string') ids.push(rest['id']);
      return rest;
    });
    stripped.push({ sceneId: String(record['id'] ?? ''), questionIds: ids });
    return { ...record, content: { ...content, questions: safeQuestions } };
  });
  return { document: { ...(document as Record<string, unknown>), scenes: next }, stripped };
};

/** 场景来源侧表的最小形状：课堂不能用 DSL 文档自带字段声明来源。 */
export interface SceneSourceBinding {
  sceneId: string;
  knowledgeIds: string[];
  questionId: string | null;
  reviewedBy: string;
  reviewNote: string;
}

/** 审核课件写入前的守卫：来源绑定缺失或知识点为空的场景不能进入正式教学。 */
export const assertSceneSourceBindings = (
  sceneIds: string[],
  bindings: ReadonlyMap<string, SceneSourceBinding>,
): void => {
  const missing: string[] = [];
  for (const sceneId of sceneIds) {
    const binding = bindings.get(sceneId);
    if (!binding || binding.knowledgeIds.length === 0 || binding.reviewedBy.length === 0) {
      missing.push(sceneId);
    }
  }
  if (missing.length > 0) {
    throw new StudyError('CLASSROOM_SCENE_SOURCE_MISSING', { sceneIds: missing });
  }
};
