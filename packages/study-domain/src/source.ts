/**
 * 机械检查（《规划书》5.3 第一道审核）。
 *
 * 只回答「引用可定位、版本一致、编号有效」，**不**回答「引用是否支持该陈述」。
 * 语义支持由人工对照审核解决，界面文案必须是「引用可定位」而不是「内容正确」。
 */

import { StudyError } from '@sew/study-contracts';
import type { EvidenceRefInput, MechanicalCheckDto } from '@sew/study-contracts';
import { fingerprintOf } from './normalize';

export interface RegisteredSegment {
  materialId: string;
  revision: number;
  segmentId: string;
  text: string;
  fingerprint: string;
}

export interface MechanicalCheckInput {
  evidence: EvidenceRefInput[];
  /** 查已登记段落；返回 undefined 表示不存在。 */
  lookupSegment: (materialId: string, revision: number, segmentId: string) => RegisteredSegment | undefined;
  /** 当前每个材料的最新版本；用于识别「引用指向旧版本」。 */
  currentRevisions: Record<string, number>;
  /** 已存在的知识点编号（用于校验前置依赖是否有效）。 */
  knownKnowledgeIds: ReadonlySet<string>;
  prerequisites: string[];
}

export interface MechanicalCheckResult extends MechanicalCheckDto {
  /** 可直接用于展示的原文摘录，按引用顺序。 */
  excerpts: Array<{ ref: EvidenceRefInput; fingerprint: string; excerpt: string }>;
}

/** 阻断性检查：不通过则候选只能停在待核实。 */
const BLOCKING_CODES = [
  'SOURCE_MISSING',
  'SOURCE_SEGMENT_NOT_FOUND',
  'SOURCE_REVISION_STALE',
  'SOURCE_FINGERPRINT_MISMATCH',
] as const;
type BlockingCode = (typeof BLOCKING_CODES)[number];
const isBlockingCode = (code: string): code is BlockingCode =>
  (BLOCKING_CODES as readonly string[]).includes(code);

export const runMechanicalCheck = (input: MechanicalCheckInput): MechanicalCheckResult => {
  const checks: MechanicalCheckDto['checks'] = [];
  const excerpts: MechanicalCheckResult['excerpts'] = [];

  if (input.evidence.length === 0) {
    checks.push({
      code: 'SOURCE_MISSING',
      ok: false,
      detail: '没有提供任何材料引用，候选只能停在待核实',
    });
  }

  for (const ref of input.evidence) {
    const currentRevision = input.currentRevisions[ref.materialId];
    if (currentRevision === undefined) {
      checks.push({
        code: 'SOURCE_SEGMENT_NOT_FOUND',
        ok: false,
        detail: `材料 ${ref.materialId} 未登记`,
      });
      continue;
    }
    if (currentRevision !== ref.revision) {
      checks.push({
        code: 'SOURCE_REVISION_STALE',
        ok: false,
        detail: `引用版本 r${ref.revision}，当前为 r${currentRevision}`,
      });
      continue;
    }

    const segment = input.lookupSegment(ref.materialId, ref.revision, ref.segmentId);
    if (!segment) {
      checks.push({
        code: 'SOURCE_SEGMENT_NOT_FOUND',
        ok: false,
        detail: `段落 ${ref.segmentId} 不在材料 ${ref.materialId} r${ref.revision} 中`,
      });
      continue;
    }

    const recomputed = fingerprintOf(segment.text);
    if (recomputed !== segment.fingerprint) {
      checks.push({
        code: 'SOURCE_FINGERPRINT_MISMATCH',
        ok: false,
        detail: `段落 ${ref.segmentId} 重算指纹与登记不一致`,
      });
      continue;
    }

    excerpts.push({ ref, fingerprint: recomputed, excerpt: segment.text });
    checks.push({
      code: 'SOURCE_LOCATED',
      ok: true,
      detail: `段落 ${ref.segmentId} 引用可定位，指纹一致`,
    });
  }

  // 前置依赖检查不阻断候选创建，但记录状态供准入阶段使用。
  const missingPrerequisites = input.prerequisites.filter((id) => !input.knownKnowledgeIds.has(id));
  checks.push({
    code: 'PREREQUISITE_UNSATISFIED',
    ok: missingPrerequisites.length === 0,
    detail:
      missingPrerequisites.length === 0
        ? '前置依赖编号有效'
        : `前置依赖未建立：${missingPrerequisites.join('、')}`,
  });

  const passed = checks.filter((c) => isBlockingCode(c.code)).every((c) => c.ok);
  return { passed, checks, excerpts };
};

/**
 * 候选创建入口的守卫。机械检查不通过时不允许把候选升级为已核实，
 * 但候选本身仍然保存，并显示具体缺口。
 */
export const assertMechanicalPassed = (result: MechanicalCheckResult): void => {
  if (result.passed) return;
  const firstFailure = result.checks.find((c) => !c.ok && isBlockingCode(c.code));
  const code: BlockingCode = firstFailure && isBlockingCode(firstFailure.code) ? firstFailure.code : 'SOURCE_MISSING';
  throw new StudyError(code, {
    failed: result.checks.filter((c) => !c.ok).map((c) => c.code),
  });
};
