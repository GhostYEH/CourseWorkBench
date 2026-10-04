/**
 * 题目持久化（repository）。
 *
 * 题目身份（origin / originLabel / originDetail）由调用方依据可信记录裁定后传入；
 * 本层不做身份判断，只负责写入与读回。
 */

import { StudyError, type QuestionOrigin, type QuestionAssessmentDto, type RecordScope } from '@sew/study-contracts';
import type { OriginRecord } from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { encodeJson } from '../json-codec';
import { defaultJsonPolicy, mapQuestion, type QuestionRow, type Row } from './types';

export interface InsertQuestionInput {
  questionId: string;
  assessment?: QuestionAssessmentDto | null;
  stem: string;
  answer: string;
  solution: string;
  knowledgeIds: string[];
  origin: QuestionOrigin;
  originLabel: string;
  originDetail: string | null;
  originRecord: OriginRecord | null;
  /** 请求声明的身份，落库用于评测区分合法新编题与被阻止的伪装题。 */
  requestedOrigin: QuestionOrigin;
  forgedExamClaim: boolean;
  recordScope: RecordScope;
}

export class QuestionsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertQuestion(input: InsertQuestionInput): QuestionRow {
    this.db
      .prepare(
        `INSERT INTO questions (question_id, stem, answer, solution, knowledge_ids_json, origin, origin_label, origin_detail, origin_record_json, requested_origin, forged_exam_claim, revision, created_at, record_scope, assessment_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        input.questionId,
        input.stem,
        input.answer,
        input.solution,
        encodeJson(input.knowledgeIds),
        input.origin,
        input.originLabel,
        input.originDetail,
        input.originRecord ? encodeJson(input.originRecord) : null,
        input.requestedOrigin,
        input.forgedExamClaim ? 1 : 0,
        new Date().toISOString(),
        input.recordScope,
        input.assessment ? encodeJson(input.assessment) : null,
      );
    const question = this.getQuestion(input.questionId);
    if (!question) throw new StudyError('INTERNAL', { questionId: input.questionId });
    return question;
  }

  getQuestion(questionId: string, scope?: RecordScope): QuestionRow | null {
    const statement = scope
      ? this.db.prepare('SELECT * FROM questions WHERE question_id = ? AND record_scope = ?')
      : this.db.prepare('SELECT * FROM questions WHERE question_id = ?');
    const row = (scope ? statement.get(questionId, scope) : statement.get(questionId)) as
      | Row
      | undefined;
    return row ? mapQuestion(row, defaultJsonPolicy) : null;
  }

  listQuestions(scope: RecordScope = 'formal'): QuestionRow[] {
    return (this.db.prepare('SELECT * FROM questions WHERE record_scope = ? ORDER BY created_at DESC').all(scope) as Row[]).map(
      (row) => mapQuestion(row, defaultJsonPolicy),
    );
  }
}
