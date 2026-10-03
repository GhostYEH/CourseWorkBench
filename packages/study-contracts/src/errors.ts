/**
 * 领域错误码。
 *
 * 每个错误码同时提供：机器可判定的 code、面向用户的中文文案、以及该错误是否
 * 表示「应停在待核实」而不是「系统故障」。界面据此选择提示样式与可执行动作。
 */

export const STUDY_ERROR_CODES = [
  // —— 来源与指纹（机械检查层）——
  'SOURCE_MISSING',
  'SOURCE_SEGMENT_NOT_FOUND',
  'SOURCE_FINGERPRINT_MISMATCH',
  'SOURCE_REVISION_STALE',
  'MATERIAL_NOT_FOUND',
  'MATERIAL_TYPE_UNSUPPORTED',

  // —— 生成准入层 ——
  'KNOWLEDGE_NOT_VERIFIED',
  'KNOWLEDGE_INVALIDATED',
  'KNOWLEDGE_SCOPE_INVALID',
  'PREREQUISITE_UNSATISFIED',
  'PLAN_NOT_CONFIRMED',

  // —— 项目身份与代次 ——
  'PROJECT_NOT_AUTHORIZED',
  'PROJECT_GENERATION_STALE',
  'PROJECT_FORMAT_UNSUPPORTED',
  'PROJECT_ALREADY_OPEN',

  // —— 版本与提交 ——
  'VERSION_CONFLICT',
  'STEP_ALREADY_COMMITTED',
  'RUN_TERMINATED',

  // —— 题目身份与数据分区 ——
  'QUESTION_ORIGIN_FORBIDDEN',
  'SIMULATION_WRITE_FORBIDDEN',
  'ROLE_PERMISSION_DENIED',

  // —— 课堂文档与审核准入 ——
  'CLASSROOM_LESSON_NOT_REVIEWED',
  'CLASSROOM_SCENE_SOURCE_MISSING',

  // —— 通用 ——
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'INTERNAL',
] as const;

export type StudyErrorCode = (typeof STUDY_ERROR_CODES)[number];

/** 面向用户的中文文案。使用「引用可定位」而不是「内容正确」。 */
export const STUDY_ERROR_MESSAGE: Record<StudyErrorCode, string> = {
  SOURCE_MISSING: '缺少支持原文，暂不能用于课程和出题',
  SOURCE_SEGMENT_NOT_FOUND: '引用的段落不存在，请重新选择材料段落',
  SOURCE_FINGERPRINT_MISMATCH: '引用段落与登记版本不一致，需重新核对原文',
  SOURCE_REVISION_STALE: '材料已更新，引用指向旧版本，请重新核实',
  MATERIAL_NOT_FOUND: '找不到该材料版本',
  MATERIAL_TYPE_UNSUPPORTED: '暂不支持该材料类型（首版支持 txt / md）',

  KNOWLEDGE_NOT_VERIFIED: '该知识点尚未核实，暂不能用于生成课程或出题',
  KNOWLEDGE_INVALIDATED: '关联来源已失效，该知识点暂停教学准入',
  KNOWLEDGE_SCOPE_INVALID: '知识点范围不合规，需先确认考纲映射',
  PREREQUISITE_UNSATISFIED: '必要前置知识尚未满足',
  PLAN_NOT_CONFIRMED: '备考计划尚未确认，不能生成正式课程',

  PROJECT_NOT_AUTHORIZED: '当前请求不属于已授权的打开项目',
  PROJECT_GENERATION_STALE: '项目已切换，该响应已失效',
  PROJECT_FORMAT_UNSUPPORTED: '项目格式版本高于当前应用，请升级后再打开',
  PROJECT_ALREADY_OPEN: '已有一个可写项目处于打开状态',

  VERSION_CONFLICT: '记录已被其他操作更新，请刷新后重试',
  STEP_ALREADY_COMMITTED: '该步骤已提交，本次为重复请求',
  RUN_TERMINATED: '任务已终止，不能继续写入',

  QUESTION_ORIGIN_FORBIDDEN: '缺少可信出处记录，不能标记为真题',
  SIMULATION_WRITE_FORBIDDEN: '模拟作答不能写入本人学习记录',
  ROLE_PERMISSION_DENIED: '当前角色没有该操作权限',

  CLASSROOM_LESSON_NOT_REVIEWED: '该课堂文档不是已登记的审核课件，不能写入正式教学',
  CLASSROOM_SCENE_SOURCE_MISSING: '课堂场景缺少可定位的来源绑定，暂不能用于教学',

  INVALID_ARGUMENT: '请求参数不合法',
  NOT_FOUND: '记录不存在',
  INTERNAL: '发生内部错误，请查看任务日志',
};

/** 需要停在待核实、不构成系统故障的错误码。 */
export const PENDING_ONLY_CODES: ReadonlySet<StudyErrorCode> = new Set<StudyErrorCode>([
  'SOURCE_MISSING',
  'SOURCE_SEGMENT_NOT_FOUND',
  'SOURCE_FINGERPRINT_MISMATCH',
  'SOURCE_REVISION_STALE',
  'KNOWLEDGE_NOT_VERIFIED',
  'KNOWLEDGE_INVALIDATED',
  'KNOWLEDGE_SCOPE_INVALID',
  'PREREQUISITE_UNSATISFIED',
  'CLASSROOM_SCENE_SOURCE_MISSING',
]);

export interface StudyErrorPayload {
  code: StudyErrorCode;
  message: string;
  /** 结构化补充信息，例如缺失的 segmentId、期望指纹等。 */
  details?: Record<string, unknown>;
  /** true 表示「停在待核实」，界面展示补材料入口而不是报错弹窗。 */
  pending: boolean;
}

export class StudyError extends Error {
  readonly code: StudyErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly pending: boolean;

  constructor(code: StudyErrorCode, details?: Record<string, unknown>, messageOverride?: string) {
    const message = messageOverride ?? STUDY_ERROR_MESSAGE[code];
    super(message);
    this.name = 'StudyError';
    this.code = code;
    this.details = details;
    this.pending = PENDING_ONLY_CODES.has(code);
  }

  toPayload(): StudyErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      pending: this.pending,
    };
  }
}

const STUDY_ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(STUDY_ERROR_CODES);

export const isStudyError = (value: unknown): value is StudyError => {
  if (value instanceof StudyError) return true;
  // 领域包与应用可能各自打包一份 contracts，此时 instanceof 会失效；
  // 因此再按结构判定一次：name、已知错误码与文案同时成立才算领域错误。
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { name?: unknown; code?: unknown; message?: unknown };
  return (
    candidate.name === 'StudyError' &&
    typeof candidate.code === 'string' &&
    STUDY_ERROR_CODE_SET.has(candidate.code) &&
    typeof candidate.message === 'string'
  );
};

export const toErrorPayload = (value: unknown): StudyErrorPayload => {
  if (isStudyError(value)) return value.toPayload();
  return {
    code: 'INTERNAL',
    message: value instanceof Error ? value.message : STUDY_ERROR_MESSAGE.INTERNAL,
    pending: false,
  };
};
