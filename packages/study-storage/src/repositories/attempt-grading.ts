import { z } from 'zod';
import {
  StudyError,
  STUDY_ERROR_CODES,
  newId,
  attemptGradeCandidateSchema,
  attemptGradeReviewSchema,
  attemptGradingContextSchema,
  type AttemptGradeCandidateDto,
  type AttemptGradingContextDto,
} from '@sew/study-contracts';
import { answerDisplayPolicy, gradeReviewedAnswer } from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { encodeJson } from '../json-codec';
import { readRequiredJsonColumn, mapAttempt, num, str, type Row, type QuestionRow } from './types';

export interface SaveAttemptGradeCandidateInput {
  projectId: string;
  attemptId: string;
  expectedReviewVersion: number;
  proposedEarned: number | null;
  basis: string;
  uncertainty: string;
  requestedModel: string | null;
  runId: string;
  requestId: string;
}
export interface ReviewAttemptGradeInput {
  projectId: string;
  attemptId: string;
  expectedReviewVersion: number;
  requestId: string;
  earned: number;
  basis: string;
  uncertainty: string;
  semanticReviewed: true;
  candidateId: string | null;
}
export interface RejectAttemptGradeCandidateInput {
  projectId: string;
  attemptId: string;
  candidateId: string;
  expectedReviewVersion: number;
  requestId: string;
  note: string;
}
export interface AttemptGradeGenerationCallInput {
  projectId: string;
  attemptId: string;
  expectedReviewVersion: number;
  requestId: string;
}
const generationFailureSchema = z
  .object({ code: z.enum(STUDY_ERROR_CODES), message: z.string().min(1).max(8000) })
  .strict();
const generationCallSchema = z
  .object({
    state: z.enum(['started', 'failed', 'completed']),
    failure: generationFailureSchema.nullable(),
  })
  .strict();
export type AttemptGradeGenerationFailure = z.infer<typeof generationFailureSchema>;
// ANSWER-01 之前的回执只缺 answerDisplay。仅仓储读取兼容这一严格旧形状，
// 并从回执冻结的提交和判分事实补展示规则；不能查询当前题目或后续审核改写旧快照。
const legacyGradingContextSchema = attemptGradingContextSchema
  .omit({ answerDisplay: true })
  .refine((context) => {
    const submission = context.submissionGrading;
    const latest = context.reviews.at(-1);
    return (
      submission.status === 'pending_review' &&
      submission.answerVersion === context.answerVersion &&
      submission.maxScore === context.maxScore &&
      context.currentReviewVersion === (latest?.reviewVersion ?? 0) &&
      encodeJson(context.effectiveGrading) === encodeJson(latest?.grading ?? submission) &&
      context.reviews.every(
        (review, index) =>
          review.attemptId === context.attemptId &&
          review.reviewVersion === index + 1 &&
          review.questionRevision === context.questionRevision &&
          review.answerVersion === context.answerVersion &&
          review.grading.answerVersion === context.answerVersion &&
          review.grading.maxScore === context.maxScore &&
          review.grading.status !== 'pending_review' &&
          review.grading.correct === (review.grading.earned === context.maxScore),
      ) &&
      context.candidates.every(
        (candidate) =>
          candidate.attemptId === context.attemptId &&
          candidate.questionRevision === context.questionRevision &&
          candidate.answerVersion === context.answerVersion &&
          (candidate.proposedEarned === null || candidate.proposedEarned <= context.maxScore),
      )
    );
  }, 'Invalid frozen grading context facts')
  .transform((context) => ({
    ...context,
    answerDisplay: answerDisplayPolicy({
      hasPersonalSubmission: true,
      submissionQuestionRevision: context.questionRevision,
      submissionAnswerVersion: context.submissionGrading.answerVersion,
      currentQuestionRevision: context.questionRevision,
      currentAnswerVersion: context.answerVersion,
      gradingStatus: context.effectiveGrading.status,
    }),
  }));
const storedGradingContextSchema = z.union([
  attemptGradingContextSchema,
  legacyGradingContextSchema,
]);
const candidateResultSchema = z
  .object({
    context: storedGradingContextSchema,
    candidate: attemptGradeCandidateSchema,
    deduplicated: z.boolean(),
  })
  .strict();
const reviewResultSchema = z
  .object({
    context: storedGradingContextSchema,
    review: attemptGradeReviewSchema,
    deduplicated: z.boolean(),
  })
  .strict();
const required = <T>(
  value: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  context: string,
): T => {
  return readRequiredJsonColumn(value, schema, context, {
    reason: 'invalid_grading_json',
    context,
  });
};

export class AttemptGradingRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly facts: {
      projectExists: (id: string) => boolean;
      question: (id: string) => QuestionRow | null;
      admitted: (ids: string[]) => boolean;
      applyMastery: (ids: string[], correct: boolean, at: string) => void;
    },
  ) {}

  context(projectId: string, attemptId: string): AttemptGradingContextDto | null {
    if (!this.facts.projectExists(projectId)) return null;
    const row = this.db
      .prepare(
        'SELECT attempts.*, questions.record_scope FROM attempts JOIN questions USING(question_id) WHERE attempt_id = ?',
      )
      .get(attemptId) as Row | undefined;
    if (!row) return null;
    const attempt = mapAttempt(row);
    const q = this.facts.question(attempt.questionId);
    if (
      !q ||
      attempt.recordScope !== 'formal' ||
      attempt.kind !== 'real' ||
      attempt.actorType !== 'human_learner' ||
      q.assessment?.type !== 'short_answer' ||
      !attempt.grading ||
      attempt.grading.status !== 'pending_review' ||
      !attempt.answerVersion ||
      !attempt.questionRevision
    )
      return null;
    const reviews = (
      this.db
        .prepare(
          'SELECT review_json FROM attempt_grade_reviews WHERE project_id=? AND attempt_id=? ORDER BY review_version',
        )
        .all(projectId, attemptId) as Row[]
    ).map((r) => required(r['review_json'], attemptGradeReviewSchema, 'attempt_grade_reviews'));
    const candidates = (
      this.db
        .prepare(
          'SELECT candidate_json FROM attempt_grade_candidates WHERE project_id=? AND attempt_id=? ORDER BY rowid',
        )
        .all(projectId, attemptId) as Row[]
    ).map((r) =>
      required(r['candidate_json'], attemptGradeCandidateSchema, 'attempt_grade_candidates'),
    );
    if (
      reviews.some(
        (r, i) =>
          r.attemptId !== attemptId ||
          r.reviewVersion !== i + 1 ||
          r.questionRevision !== attempt.questionRevision ||
          r.answerVersion !== attempt.answerVersion ||
          r.grading.maxScore !== attempt.grading!.maxScore ||
          r.grading.answerVersion !== attempt.answerVersion ||
          r.grading.correct !== (r.grading.earned === r.grading.maxScore),
      ) ||
      candidates.some(
        (c) =>
          c.attemptId !== attemptId ||
          c.questionRevision !== attempt.questionRevision ||
          c.answerVersion !== attempt.answerVersion ||
          (c.proposedEarned !== null && c.proposedEarned > attempt.grading!.maxScore),
      )
    )
      throw new StudyError('INTERNAL', { reason: 'grading_fact_binding_invalid' });
    // There is no question edit API yet. If external mutation changes the version,
    // current reference text must never masquerade as the original frozen rubric.
    if (
      q.revision !== attempt.questionRevision ||
      q.assessment.answerVersion !== attempt.answerVersion ||
      attempt.grading.answerVersion !== attempt.answerVersion ||
      q.assessment.maxScore !== attempt.grading.maxScore
    )
      throw new StudyError('VERSION_CONFLICT', { reason: 'attempt_question_rule_version_changed' });
    if (
      reviews.some(
        (r) =>
          r.appliedKnowledgeIds &&
          ([...r.appliedKnowledgeIds, ...r.skippedKnowledgeIds!].length !== q.knowledgeIds.length ||
            [...r.appliedKnowledgeIds, ...r.skippedKnowledgeIds!].some(
              (id) => !q.knowledgeIds.includes(id),
            )),
      )
    )
      throw new StudyError('INTERNAL', { reason: 'grading_mastery_binding_invalid' });
    const reason = !this.facts.admitted(q.knowledgeIds) ? '关联来源已失效或知识点不再准入' : null;
    // 答案展示规则由服务端裁定：这里有「本人已提交 + 版本一致」的事实，简答待判分时不给评分依据。
    const answerDisplay = answerDisplayPolicy({
      hasPersonalSubmission: true,
      submissionQuestionRevision: attempt.questionRevision,
      submissionAnswerVersion: attempt.answerVersion,
      currentQuestionRevision: q.revision,
      currentAnswerVersion: q.assessment.answerVersion,
      gradingStatus: reviews.at(-1)?.grading.status ?? attempt.grading.status,
    });
    return attemptGradingContextSchema.parse({
      attemptId,
      questionId: q.questionId,
      questionRevision: attempt.questionRevision,
      answerVersion: attempt.answerVersion,
      stem: q.stem,
      answerText: attempt.answerText,
      processText: attempt.processText,
      referenceAnswer: q.answer,
      solution: q.solution,
      rubric: q.assessment.rubric,
      maxScore: attempt.grading.maxScore,
      submissionGrading: attempt.grading,
      effectiveGrading: reviews.at(-1)?.grading ?? attempt.grading,
      currentReviewVersion: reviews.at(-1)?.reviewVersion ?? 0,
      reviews,
      candidates,
      knowledgeIds: q.knowledgeIds,
      canReview: reason === null,
      reviewBlockedReason: reason,
      answerDisplay,
    });
  }
  private writable(projectId: string, attemptId: string, version: number) {
    const context = this.context(projectId, attemptId);
    if (!context) throw new StudyError('INVALID_ARGUMENT', { reason: 'attempt_not_reviewable' });
    if (!context.canReview)
      throw new StudyError('KNOWLEDGE_NOT_VERIFIED', { reason: context.reviewBlockedReason });
    if (context.currentReviewVersion !== version)
      throw new StudyError('VERSION_CONFLICT', { reason: 'review_version_stale' });
    return context;
  }
  private receipt(projectId: string, requestId: string) {
    return this.db
      .prepare('SELECT * FROM attempt_grade_receipts WHERE project_id=? AND request_id=?')
      .get(projectId, requestId) as Row | undefined;
  }
  private retry<T>(
    input: { projectId: string; requestId: string },
    action: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): T | null {
    if (
      action !== 'generate' &&
      this.db
        .prepare('SELECT 1 FROM attempt_grade_generation_calls WHERE project_id=? AND request_id=?')
        .get(input.projectId, input.requestId)
    )
      throw new StudyError('VERSION_CONFLICT', { reason: 'grading_nonce_reused' });
    const receipt = this.receipt(input.projectId, input.requestId);
    if (!receipt) return null;
    if (receipt['action'] !== action || receipt['intent_json'] !== encodeJson(input))
      throw new StudyError('VERSION_CONFLICT', { reason: 'grading_nonce_reused' });
    return required(receipt['result_json'], schema, 'attempt_grade_receipts');
  }
  private saveReceipt(
    input: { projectId: string; requestId: string; attemptId: string },
    action: string,
    result: unknown,
  ) {
    if (!input.requestId.trim())
      throw new StudyError('INVALID_ARGUMENT', { reason: 'missing_grading_nonce' });
    this.db
      .prepare(
        'INSERT INTO attempt_grade_receipts (project_id, request_id, action, attempt_id, intent_json, result_json) VALUES (?,?,?,?,?,?)',
      )
      .run(
        input.projectId,
        input.requestId,
        action,
        input.attemptId,
        encodeJson(input),
        encodeJson(result),
      );
  }
  getCandidateReceipt(projectId: string, attemptId: string, requestId: string) {
    const receipt = this.receipt(projectId, requestId);
    if (!receipt) return null;
    if (receipt['action'] !== 'generate' || receipt['attempt_id'] !== attemptId)
      throw new StudyError('VERSION_CONFLICT', { reason: 'grading_nonce_reused' });
    return {
      ...required(receipt['result_json'], candidateResultSchema, 'attempt_grade_receipts'),
      deduplicated: true as const,
    };
  }
  getGenerationCall(input: AttemptGradeGenerationCallInput) {
    const row = this.db
      .prepare('SELECT * FROM attempt_grade_generation_calls WHERE project_id=? AND request_id=?')
      .get(input.projectId, input.requestId) as Row | undefined;
    if (!row) return null;
    if (
      row['attempt_id'] !== input.attemptId ||
      row['expected_review_version'] !== input.expectedReviewVersion
    )
      throw new StudyError('VERSION_CONFLICT', { reason: 'grading_nonce_reused' });
    const call = generationCallSchema.parse({
      state: row['state'],
      failure:
        row['failure_json'] === null
          ? null
          : required(
              row['failure_json'],
              generationFailureSchema,
              'attempt_grade_generation_calls',
            ),
    });
    if ((call.state === 'failed') !== (call.failure !== null))
      throw new StudyError('INTERNAL', { reason: 'invalid_grading_generation_state' });
    return call;
  }
  startGenerationCall(
    input: AttemptGradeGenerationCallInput,
    runId: string,
    reservedTokens: number,
  ) {
    return this.db.transaction(() => {
      this.writable(input.projectId, input.attemptId, input.expectedReviewVersion);
      if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 1)
        throw new StudyError('INVALID_ARGUMENT', { reason: 'invalid_grading_reservation' });
      if (
        !input.requestId.trim() ||
        this.receipt(input.projectId, input.requestId) ||
        this.getGenerationCall(input)
      )
        throw new StudyError('VERSION_CONFLICT', { reason: 'grading_nonce_reused' });
      const at = new Date().toISOString();
      // 显式列名而不是位置插入：v25 追加了三列，位置写法一旦列顺序变化就会静默错位。
      this.db
        .prepare(
          `INSERT INTO attempt_grade_generation_calls
           (project_id, request_id, attempt_id, expected_review_version, run_id, reserved_tokens, state, failure_json, created_at, updated_at, accounted_tokens, token_measurement, elapsed_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'started', NULL, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          input.projectId,
          input.requestId,
          input.attemptId,
          input.expectedReviewVersion,
          runId,
          reservedTokens,
          at,
          at,
        );
    });
  }

  /**
   * 评分生成调用的预算占用与计量（BUDGET-01）。
   *
   * 口径与模型台账一致，且必须能回答「已结算的评分花了多少」——只统计 `started`
   * 会让已结算的评分从共享预算里消失，未知用量则会被静默按 0 计。
   * `unknownRetentionTokens` 专门表示「已派发但用量无法确认」那部分继续保留的预占。
   */
  generationAccounting(
    runId: string,
    ownRequestId?: string,
  ): {
    calls: number;
    tokens: number;
    unknownRetentionTokens: number;
    activeElapsedMs: number;
    rows: Array<{
      requestId: string;
      state: 'started' | 'failed' | 'completed';
      reservedTokens: number;
      accountedTokens: number | null;
      tokenMeasurement: string | null;
      elapsedMs: number | null;
      createdAt: string;
      updatedAt: string;
      projectId: string;
    }>;
  } {
    const rows = this.db
      .prepare(
        'SELECT request_id, state, reserved_tokens, accounted_tokens, token_measurement, elapsed_ms, created_at, updated_at, project_id FROM attempt_grade_generation_calls WHERE run_id=? ORDER BY created_at, request_id',
      )
      .all(runId) as Row[];
    const mapped = rows.map((row) => ({
      requestId: str(row['request_id']),
      state: str(row['state']) as 'started' | 'failed' | 'completed',
      reservedTokens: num(row['reserved_tokens']),
      accountedTokens:
        row['accounted_tokens'] === null || row['accounted_tokens'] === undefined
          ? null
          : num(row['accounted_tokens']),
      tokenMeasurement:
        row['token_measurement'] === null || row['token_measurement'] === undefined
          ? null
          : str(row['token_measurement']),
      elapsedMs:
        row['elapsed_ms'] === null || row['elapsed_ms'] === undefined
          ? null
          : num(row['elapsed_ms']),
      createdAt: str(row['created_at']),
      updatedAt: str(row['updated_at']),
      projectId: str(row['project_id']),
    }));
    const own = ownRequestId ?? '';
    let calls = 0;
    let tokens = 0;
    let unknownRetentionTokens = 0;
    let activeElapsedMs = 0;
    for (const row of mapped) {
      if (row.requestId === own) continue;
      calls += 1;
      if (row.state === 'started') {
        // 未结算：整笔预占继续占额度。
        tokens += row.reservedTokens;
        continue;
      }
      activeElapsedMs += row.elapsedMs ?? 0;
      if (row.tokenMeasurement === 'actual' || row.tokenMeasurement === 'estimated') {
        // 行本身是结算依据；Store 归一时用这行替换对应事件，避免双计。
        tokens += row.accountedTokens ?? 0;
        continue;
      }
      // 已派发但用量不明：保留整笔预占，绝不按 0 计。
      tokens += row.reservedTokens;
      unknownRetentionTokens += row.reservedTokens;
    }
    return { calls, tokens, unknownRetentionTokens, activeElapsedMs, rows: mapped };
  }

  /** 未结算的评分调用清单。 */
  listPendingGenerationCalls(
    runId: string,
  ): Array<{ requestId: string; reservedTokens: number; createdAt: string }> {
    return this.generationAccounting(runId)
      .rows.filter((row) => row.state === 'started')
      .map((row) => ({
        requestId: row.requestId,
        reservedTokens: row.reservedTokens,
        createdAt: row.createdAt,
      }));
  }
  /**
   * 结算评分生成调用。
   *
   * `accounting` 记录这次调用的真实计量：provider 给了计数就是实际，只有本地估算
   * 就是估算，两者都没有就是未知。未知时预占继续保留——否则「发出去了但结果不明」
   * 的评分会被当成没花钱，用户看到的剩余额度就是假的。
   */
  settleGenerationCall(
    input: AttemptGradeGenerationCallInput,
    failure: AttemptGradeGenerationFailure | null,
    accounting: {
      accountedTokens: number;
      tokenMeasurement: 'actual' | 'estimated' | 'unknown';
      elapsedMs: number;
    } = { accountedTokens: 0, tokenMeasurement: 'unknown', elapsedMs: 0 },
  ) {
    const old = this.getGenerationCall(input);
    if (old?.state !== 'started')
      throw new StudyError('VERSION_CONFLICT', { reason: 'grading_generation_already_settled' });
    const parsed = failure === null ? null : generationFailureSchema.parse(failure);
    if (!Number.isSafeInteger(accounting.accountedTokens) || accounting.accountedTokens < 0) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'invalid_grading_accounting' });
    }
    this.db
      .prepare(
        'UPDATE attempt_grade_generation_calls SET state=?,failure_json=?,accounted_tokens=?,token_measurement=?,elapsed_ms=?,updated_at=? WHERE project_id=? AND request_id=?',
      )
      .run(
        parsed ? 'failed' : 'completed',
        parsed ? encodeJson(parsed) : null,
        accounting.accountedTokens,
        accounting.tokenMeasurement,
        accounting.elapsedMs,
        new Date().toISOString(),
        input.projectId,
        input.requestId,
      );
  }
  saveCandidate(input: SaveAttemptGradeCandidateInput) {
    const old = this.retry(input, 'generate', candidateResultSchema);
    if (old) return { ...old, deduplicated: true };
    return this.db.transaction(() => {
      const context = this.writable(input.projectId, input.attemptId, input.expectedReviewVersion);
      if (
        input.proposedEarned !== null &&
        (!Number.isFinite(input.proposedEarned) ||
          input.proposedEarned < 0 ||
          input.proposedEarned > context.maxScore)
      )
        throw new StudyError('INVALID_ARGUMENT', { reason: 'candidate_score_invalid' });
      const candidate = attemptGradeCandidateSchema.parse({
        candidateId: newId('agc'),
        attemptId: input.attemptId,
        questionRevision: context.questionRevision,
        answerVersion: context.answerVersion,
        expectedReviewVersion: input.expectedReviewVersion,
        proposedEarned: input.proposedEarned,
        basis: input.basis,
        uncertainty: input.uncertainty,
        status: 'pending',
        requestedModel: input.requestedModel,
        runId: input.runId,
        createdAt: new Date().toISOString(),
        reviewNote: '',
      });
      this.db
        .prepare(
          'INSERT INTO attempt_grade_candidates (candidate_id, project_id, attempt_id, candidate_json) VALUES (?,?,?,?)',
        )
        .run(candidate.candidateId, input.projectId, input.attemptId, encodeJson(candidate));
      const result = {
        context: this.context(input.projectId, input.attemptId)!,
        candidate,
        deduplicated: false,
      };
      this.saveReceipt(input, 'generate', result);
      return result;
    });
  }
  private pendingCandidate(
    context: AttemptGradingContextDto,
    id: string,
  ): AttemptGradeCandidateDto {
    const candidate = context.candidates.find((c) => c.candidateId === id);
    if (
      !candidate ||
      candidate.status !== 'pending' ||
      candidate.expectedReviewVersion !== context.currentReviewVersion ||
      candidate.questionRevision !== context.questionRevision ||
      candidate.answerVersion !== context.answerVersion
    )
      throw new StudyError('VERSION_CONFLICT', { reason: 'candidate_stale_or_reviewed' });
    return candidate;
  }
  review(input: ReviewAttemptGradeInput) {
    const old = this.retry(input, 'review', reviewResultSchema);
    if (old) return { ...old, deduplicated: true };
    return this.db.transaction(() => {
      const context = this.writable(input.projectId, input.attemptId, input.expectedReviewVersion);
      const candidate = input.candidateId
        ? this.pendingCandidate(context, input.candidateId)
        : null;
      if (candidate?.proposedEarned === null)
        throw new StudyError('INVALID_ARGUMENT', { reason: 'candidate_has_no_grade' });
      const grading = gradeReviewedAnswer({
        ...input,
        maxScore: context.maxScore,
        answerVersion: context.answerVersion,
      });
      const at = new Date().toISOString();
      // Submission order is SQLite's insertion order, even if two attempts share the same millisecond.
      const later = this.db
        .prepare(
          `SELECT a.attempt_id,a.question_id,a.mastery_after,
        (SELECT review_json FROM attempt_grade_reviews r WHERE r.attempt_id=a.attempt_id ORDER BY review_version DESC LIMIT 1) AS review_json
        FROM attempts a JOIN questions q USING(question_id)
        WHERE a.rowid > (SELECT rowid FROM attempts WHERE attempt_id=?) AND a.kind='real' AND a.actor_type='human_learner' AND q.record_scope='formal'
        AND (EXISTS(SELECT 1 FROM attempt_grade_reviews r WHERE r.attempt_id=a.attempt_id) OR a.mastery_after IS NOT NULL)`,
        )
        .all(input.attemptId) as Row[];
      const covered = new Set(
        later.flatMap((r) => {
          const reviewed =
            r['review_json'] == null
              ? null
              : required(r['review_json'], attemptGradeReviewSchema, 'attempt_grade_reviews');
          if (reviewed)
            return (
              reviewed.appliedKnowledgeIds ??
              (reviewed.masteryApplied
                ? (this.facts.question(String(r['question_id']))?.knowledgeIds ?? [])
                : [])
            );
          return r['mastery_after'] == null
            ? []
            : (this.facts.question(String(r['question_id']))?.knowledgeIds ?? []);
        }),
      );
      const appliedKnowledgeIds = context.knowledgeIds.filter((id) => !covered.has(id));
      const skippedKnowledgeIds = context.knowledgeIds.filter((id) => covered.has(id));
      const masteryApplied = appliedKnowledgeIds.length > 0;
      const review = attemptGradeReviewSchema.parse({
        reviewId: newId('agr'),
        attemptId: input.attemptId,
        reviewVersion: context.currentReviewVersion + 1,
        questionRevision: context.questionRevision,
        answerVersion: context.answerVersion,
        grading,
        basis: input.basis,
        uncertainty: input.uncertainty,
        source: candidate ? 'model_reviewed' : 'manual',
        candidateId: input.candidateId,
        reviewer: 'local_user',
        masteryApplied,
        appliedKnowledgeIds,
        skippedKnowledgeIds,
        createdAt: at,
      });
      this.db
        .prepare(
          'INSERT INTO attempt_grade_reviews (review_id, project_id, attempt_id, review_version, review_json) VALUES (?,?,?,?,?)',
        )
        .run(
          review.reviewId,
          input.projectId,
          input.attemptId,
          review.reviewVersion,
          encodeJson(review),
        );
      if (candidate)
        this.db
          .prepare('UPDATE attempt_grade_candidates SET candidate_json=? WHERE candidate_id=?')
          .run(
            encodeJson({ ...candidate, status: 'approved', reviewNote: input.basis }),
            candidate.candidateId,
          );
      if (masteryApplied)
        this.facts.applyMastery(appliedKnowledgeIds, grading.correct === true, at);
      const result = {
        context: this.context(input.projectId, input.attemptId)!,
        review,
        deduplicated: false,
      };
      this.saveReceipt(input, 'review', result);
      return result;
    });
  }
  reject(input: RejectAttemptGradeCandidateInput) {
    const old = this.retry(input, 'reject', candidateResultSchema);
    if (old) return { ...old, deduplicated: true };
    return this.db.transaction(() => {
      const context = this.writable(input.projectId, input.attemptId, input.expectedReviewVersion);
      // Rejection can clean up an outdated proposal, but still needs a current CAS.
      const pending = context.candidates.find((c) => c.candidateId === input.candidateId);
      if (!pending || pending.status !== 'pending')
        throw new StudyError('VERSION_CONFLICT', { reason: 'candidate_already_reviewed' });
      if (!input.note.trim())
        throw new StudyError('INVALID_ARGUMENT', { reason: 'reject_note_required' });
      const candidate = attemptGradeCandidateSchema.parse({
        ...pending,
        status: 'rejected',
        reviewNote: input.note,
      });
      this.db
        .prepare('UPDATE attempt_grade_candidates SET candidate_json=? WHERE candidate_id=?')
        .run(encodeJson(candidate), candidate.candidateId);
      const result = {
        context: this.context(input.projectId, input.attemptId)!,
        candidate,
        deduplicated: false,
      };
      this.saveReceipt(input, 'reject', result);
      return result;
    });
  }
}
