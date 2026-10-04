/**
 * 题目身份（《规划书》5.5）。
 *
 * 「材料原题」不自动等于「考试真题」。题目类型由可信导入或生成流程设置，
 * AI 返回的「真题」文字不具有分类权限；讲义中的出处文字也由模板统一渲染。
 */

import type { QuestionOrigin } from '@sew/study-contracts';
import { QUESTION_ORIGIN_LABEL } from '@sew/study-contracts';

export interface OriginRecord {
  materialId: string;
  revision: number;
  questionNumber: string;
  rewrittenFrom: string | null;
  rewriteNote: string;
}

/**
 * 服务端权威事实：某材料版本是否已由授权审核操作核实为考试真题来源。
 * 由存储层从 `material_exam_verifications` 派生，请求方无法自报。
 */
export interface TrustedOriginFacts {
  /** 引用的 `(materialId, revision)` 是否真实登记在材料表中。 */
  materialRegistered: boolean;
  materialVerifiedAsExam: boolean;
}

export interface OriginResolution {
  origin: QuestionOrigin;
  originLabel: string;
  originDetail: string | null;
  /** 请求身份被降级（通常是自报真题但缺少可信记录）。 */
  downgraded: boolean;
  /** true 表示这是一次「新编题自称真题」的结构性伪装尝试，应计入攻击统计。 */
  forgedExamClaim: boolean;
  reason: string | null;
}

const detailOf = (record: OriginRecord): string =>
  `材料 ${record.materialId} r${record.revision}${record.questionNumber ? ` 第 ${record.questionNumber} 题` : ''}`;

/**
 * 依据可信创建/导入记录与**服务端权威事实**裁定题目身份。不抛错：伪装真题只被降级，
 * 合法的新编身份仍然可用。`trusted` 必须来自权威存储，不能来自请求自报。
 */
export const resolveQuestionOrigin = (
  requestedOrigin: QuestionOrigin,
  record: OriginRecord | null,
  trusted: TrustedOriginFacts,
): OriginResolution => {
  const finish = (
    origin: QuestionOrigin,
    originDetail: string | null,
    downgraded: boolean,
    reason: string | null,
    forgedExamClaim = false,
  ): OriginResolution => ({
    origin,
    originLabel: QUESTION_ORIGIN_LABEL[origin],
    originDetail,
    downgraded,
    forgedExamClaim,
    reason,
  });

  switch (requestedOrigin) {
    case 'exam_original': {
      if (!record || !record.questionNumber) {
        return finish('ai_new', null, true, '缺少可信出处记录，不能标记为真题', true);
      }
      if (!trusted.materialRegistered) {
        return finish('ai_new', null, true, '引用的材料版本未登记，不能标记为真题', true);
      }
      if (trusted.materialVerifiedAsExam !== true) {
        return finish(
          'material_original',
          detailOf(record),
          true,
          '材料身份未经人工核实为考试真题，只保留材料原题身份',
          true,
        );
      }
      return finish('exam_original', detailOf(record), false, null);
    }

    case 'material_original': {
      if (!record || !record.questionNumber) {
        return finish('ai_new', null, true, '缺少材料题号记录，降级为 AI 新编题');
      }
      if (!trusted.materialRegistered) {
        return finish('ai_new', null, true, '引用的材料版本未登记，降级为 AI 新编题');
      }
      return finish('material_original', detailOf(record), false, null);
    }

    case 'material_rewrite': {
      if (!record || !record.rewrittenFrom) {
        return finish('ai_new', null, true, '未绑定原题，不能标记为材料改写');
      }
      if (!trusted.materialRegistered) {
        return finish('ai_new', null, true, '引用的材料版本未登记，降级为 AI 新编题');
      }
      const note = record.rewriteNote ? `；主要变化：${record.rewriteNote}` : '';
      return finish('material_rewrite', `${detailOf(record)}${note}`, false, null);
    }

    case 'ai_new':
    default:
      return finish('ai_new', null, false, null);
  }
};
