import { z } from 'zod';
import { StudyError, newId, feedbackContextSchema, feedbackSnapshotSchema, feedbackEntrySchema, feedbackResultSchema,
  feedbackReviewCommandSchema, reviewTaskSchema, type FeedbackReviewCommand, type FeedbackContextDto } from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { encodeJson } from '../json-codec';
import { readRequiredJsonColumn, mapAttempt, type Row, type QuestionRow, type KnowledgeRow } from './types';

/** Immutable original facts, independent human conclusions and independent practice history. */
export class FeedbackReviewRepository {
  constructor(private readonly db: SqlDatabase, private readonly facts: {
    projectExists: (id: string) => boolean; question: (id: string) => QuestionRow | null;
    knowledge: (id: string) => KnowledgeRow | null; admitted: (ids: string[]) => boolean;
  }) {}
  private read<T>(value: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
    return readRequiredJsonColumn(value, schema, 'feedback_review', { reason: 'feedback_history_corrupt' });
  }
  private authorize(projectId: string, uid: string) {
    const binding = this.db.prepare('SELECT learner_uid FROM learner_identity_bindings WHERE project_id=?').get(projectId) as Row | undefined;
    if (!this.facts.projectExists(projectId) || binding?.['learner_uid'] !== uid) throw new StudyError('PROJECT_NOT_AUTHORIZED');
  }
  private attempt(attemptId: string) {
    const row = this.db.prepare('SELECT attempts.*,questions.record_scope FROM attempts JOIN questions USING(question_id) WHERE attempt_id=?').get(attemptId) as Row | undefined;
    const attempt = row ? mapAttempt(row) : null;
    if (!attempt || attempt.kind !== 'real' || attempt.actorType !== 'human_learner' || attempt.recordScope !== 'formal' || !attempt.questionRevision) throw new StudyError('NOT_FOUND', { reason: 'personal_attempt_required' });
    return attempt;
  }
  /** Call inside the original submission transaction, before any derived mastery effects. */
  captureOriginal(projectId: string, uid: string, attemptId: string) {
    this.authorize(projectId, uid);
    const context = this.context(projectId, uid, attemptId);
    const snapshot = feedbackSnapshotSchema.parse({ ...context.snapshot, evidence: context.snapshot.knowledgeIds.map(id => {
      const knowledge = this.facts.knowledge(id);
      if (!knowledge) throw new StudyError('KNOWLEDGE_NOT_VERIFIED');
      return { knowledgeId: id, revision: knowledge.revision, references: knowledge.evidence };
    }) });
    // A snapshot already committed can never be overwritten, including by a retried submission.
    this.db.prepare('INSERT OR IGNORE INTO feedback_originals (project_id, uid, attempt_id, snapshot_json) VALUES (?,?,?,?)').run(projectId, uid, attemptId, encodeJson(snapshot));
  }
  context(projectId: string, uid: string, attemptId: string): FeedbackContextDto {
    this.authorize(projectId, uid);
    const owner = this.db.prepare('SELECT project_id,uid FROM feedback_originals WHERE attempt_id=? LIMIT 1').get(attemptId) as Row | undefined;
    if (owner && (owner['project_id'] !== projectId || owner['uid'] !== uid)) throw new StudyError('PROJECT_NOT_AUTHORIZED', { reason: 'attempt_owner_mismatch' });
    const attempt = this.attempt(attemptId);
    const question = this.facts.question(attempt.questionId);
    if (!question) throw new StudyError('NOT_FOUND');
    const stored = this.db.prepare('SELECT snapshot_json FROM feedback_originals WHERE project_id=? AND uid=? AND attempt_id=?').get(projectId, uid, attemptId) as Row | undefined;
    // Before the first write, a changed question cannot be substituted for the original rules.
    if (!stored && (question.revision !== attempt.questionRevision || (question.assessment?.answerVersion ?? null) !== attempt.answerVersion)) throw new StudyError('VERSION_CONFLICT', { reason: 'original_rule_unavailable' });
    const snapshot = stored ? this.read(stored['snapshot_json'], feedbackSnapshotSchema) : feedbackSnapshotSchema.parse({
      questionId: question.questionId, questionRevision: attempt.questionRevision, answerVersion: attempt.answerVersion,
      stem: question.stem, answer: question.answer, solution: question.solution, rubric: question.assessment?.rubric ?? '', originLabel: question.originLabel,
      knowledgeIds: question.knowledgeIds, evidence: [], answerText: attempt.answerText, processText: attempt.processText,
    });
    if (snapshot.questionId !== attempt.questionId || snapshot.questionRevision !== attempt.questionRevision || snapshot.answerVersion !== attempt.answerVersion
      || snapshot.answerText !== attempt.answerText || snapshot.processText !== attempt.processText) throw new StudyError('INTERNAL', { reason: 'feedback_original_binding_corrupt' });
    const entries = (this.db.prepare('SELECT entry_json FROM feedback_entries WHERE project_id=? AND uid=? AND attempt_id=? ORDER BY version').all(projectId, uid, attemptId) as Row[])
      .map(row => this.read(row['entry_json'], feedbackEntrySchema));
    if (entries.some((entry, index) => entry.version !== index + 1)) throw new StudyError('INTERNAL', { reason: 'feedback_version_corrupt' });
    const blockedReason = !stored ? '历史作答未冻结提交时依据，请重新提交本人作答建立可核验记录' : question.revision !== snapshot.questionRevision || (question.assessment?.answerVersion ?? null) !== snapshot.answerVersion
      ? '题目或答案规则已变更，请保留原历史并使用新题作答' : !this.facts.admitted(snapshot.knowledgeIds) ? '关联来源已失效，暂停新审核与复习完成' : null;
    return feedbackContextSchema.parse({ attemptId, snapshot, version: entries.length, entries, canWrite: blockedReason === null, blockedReason });
  }
  tasks(projectId: string, uid: string) {
    this.authorize(projectId, uid);
    return (this.db.prepare('SELECT task_json FROM feedback_review_tasks WHERE project_id=? AND uid=? ORDER BY due_at,task_id').all(projectId, uid) as Row[])
      .map(row => this.read(row['task_json'], reviewTaskSchema));
  }
  private newAttempt(projectId: string, uid: string, originalId: string, nextId: string, snapshot: FeedbackContextDto['snapshot'], watermark: number) {
    const next = this.attempt(nextId);
    const ordinal = this.db.prepare('SELECT rowid AS ordinal FROM attempts WHERE attempt_id=?').get(nextId) as Row;
    const binding = this.db.prepare('SELECT snapshot_json FROM feedback_originals WHERE project_id=? AND uid=? AND attempt_id=?').get(projectId, uid, nextId) as Row | undefined;
    const frozen = binding ? this.read(binding['snapshot_json'], feedbackSnapshotSchema) : null;
    if (nextId === originalId || next.questionId !== snapshot.questionId || next.questionRevision !== snapshot.questionRevision || next.answerVersion !== snapshot.answerVersion
      || Number(ordinal['ordinal']) <= watermark || !frozen || frozen.answerText !== next.answerText || frozen.processText !== next.processText
      || frozen.questionRevision !== snapshot.questionRevision || frozen.answerVersion !== snapshot.answerVersion || encodeJson(frozen.evidence) !== encodeJson(snapshot.evidence))
      throw new StudyError('INVALID_ARGUMENT', { reason: 'new_personal_attempt_required' });
    return next;
  }
  command(projectId: string, uid: string, raw: FeedbackReviewCommand, origin: 'manual' | 'model' = 'manual') {
    const command = feedbackReviewCommandSchema.parse(raw);
    this.authorize(projectId, uid);
    if (command.scope.projectId !== projectId) throw new StudyError('PROJECT_NOT_AUTHORIZED');
    const intent = encodeJson(command);
    return this.db.transaction(() => {
      const receipt = this.db.prepare('SELECT intent_json,result_json FROM feedback_receipts WHERE project_id=? AND uid=? AND request_id=?').get(projectId, uid, command.requestId) as Row | undefined;
      if (receipt) {
        if (receipt['intent_json'] !== intent) throw new StudyError('VERSION_CONFLICT', { reason: 'feedback_nonce_reused' });
        return { ...this.read(receipt['result_json'], feedbackResultSchema), deduplicated: true };
      }
      const context = this.context(projectId, uid, command.attemptId);
      if (!context.canWrite) throw new StudyError('KNOWLEDGE_NOT_VERIFIED', { reason: context.blockedReason });
      if (context.version !== command.expectedVersion) throw new StudyError('VERSION_CONFLICT', { reason: 'feedback_version_stale' });
      this.db.prepare('INSERT OR IGNORE INTO feedback_originals (project_id, uid, attempt_id, snapshot_json) VALUES (?,?,?,?)').run(projectId, uid, command.attemptId, encodeJson(context.snapshot));
      const at = new Date().toISOString();
      const version = context.version + 1;
      let entry: z.input<typeof feedbackEntrySchema> | null = null;
      if (command.action === 'propose' || command.action === 'review') {
        const conclusion = command.conclusion;
        if (new Set(conclusion.tags).size !== conclusion.tags.length) throw new StudyError('INVALID_ARGUMENT', { reason: 'duplicate_error_tags' });
        const unknown = conclusion.tags.length === 1 && conclusion.tags[0] === 'unknown';
        if ((!context.snapshot.processText.trim() || !conclusion.evidence.length) && !unknown) throw new StudyError('INVALID_ARGUMENT', { reason: 'insufficient_process_evidence' });
        if (conclusion.evidence.some(e => e.end <= e.start || e.end > context.snapshot.processText.length || context.snapshot.processText.slice(e.start, e.end) !== e.quote)) throw new StudyError('INVALID_ARGUMENT', { reason: 'process_location_mismatch' });
        if (command.action === 'review' && command.candidateId) {
          const candidate = context.entries.find(e => e.entryId === command.candidateId && e.action === 'propose');
          if (!candidate || context.entries.some(e => e.action === 'review' && e.candidateId === candidate.entryId)) throw new StudyError('VERSION_CONFLICT', { reason: 'candidate_already_reviewed' });
        }
        entry = { entryId: newId('err'), action: command.action, version, candidateId: command.action === 'review' ? command.candidateId : null,
          conclusion, correction: '', retryAttemptId: null, createdAt: at };
      } else if (command.action === 'correct' || command.action === 'retry') {
        if (command.action === 'retry') {
          const original = this.db.prepare('SELECT rowid AS ordinal FROM attempts WHERE attempt_id=?').get(command.attemptId) as Row;
          this.newAttempt(projectId, uid, command.attemptId, command.retryAttemptId, context.snapshot, Number(original['ordinal']));
          if (context.entries.some(e => e.retryAttemptId === command.retryAttemptId)) throw new StudyError('VERSION_CONFLICT', { reason: 'retry_already_linked' });
        }
        entry = { entryId: newId('err'), action: command.action, version, candidateId: null, conclusion: null,
          correction: command.action === 'correct' ? command.correction : '', retryAttemptId: command.action === 'retry' ? command.retryAttemptId : null, createdAt: at };
      } else {
        const tasks = this.tasks(projectId, uid);
        if (command.action === 'draft') {
          if (tasks.some(t => t.attemptId === command.attemptId && t.status !== 'completed')) throw new StudyError('VERSION_CONFLICT', { reason: 'active_review_task_exists' });
          const task = reviewTaskSchema.parse({ taskId: newId('rev'), attemptId: command.attemptId, uid, origin, questionId: context.snapshot.questionId,
            questionRevision: context.snapshot.questionRevision, dueAt: command.dueAt, reason: command.reason, status: 'draft', createdAt: at,
            confirmedAt: null, completedAt: null, completionAttemptId: null, version: 0, watermark: 0 });
          this.db.prepare('INSERT INTO feedback_review_tasks (project_id, uid, task_id, attempt_id, due_at, task_json) VALUES (?,?,?,?,?,?)').run(projectId, uid, task.taskId, task.attemptId, task.dueAt, encodeJson(task));
        } else {
          const task = tasks.find(t => t.taskId === command.taskId && t.attemptId === command.attemptId);
          if (!task) throw new StudyError('NOT_FOUND');
          if (command.action === 'confirm') {
            if (task.status !== 'draft') throw new StudyError('VERSION_CONFLICT', { reason: 'review_task_not_draft' });
            const row = this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS watermark FROM attempts').get() as Row;
            const next = reviewTaskSchema.parse({ ...task, status: 'confirmed', confirmedAt: at, version: task.version + 1, watermark: Number(row['watermark']) });
            this.db.prepare('UPDATE feedback_review_tasks SET task_json=? WHERE project_id=? AND uid=? AND task_id=?').run(encodeJson(next), projectId, uid, task.taskId);
          } else {
            if (task.status !== 'confirmed') throw new StudyError('VERSION_CONFLICT', { reason: 'review_task_not_confirmed' });
            if (task.questionId !== context.snapshot.questionId || task.questionRevision !== context.snapshot.questionRevision) throw new StudyError('INTERNAL', { reason: 'review_task_binding_corrupt' });
            this.newAttempt(projectId, uid, command.attemptId, command.completionAttemptId, context.snapshot, task.watermark);
            if (tasks.some(t => t.completionAttemptId === command.completionAttemptId)) throw new StudyError('VERSION_CONFLICT', { reason: 'completion_attempt_reused' });
            const next = reviewTaskSchema.parse({ ...task, status: 'completed', completedAt: at, completionAttemptId: command.completionAttemptId, version: task.version + 1 });
            this.db.prepare('UPDATE feedback_review_tasks SET task_json=? WHERE project_id=? AND uid=? AND task_id=?').run(encodeJson(next), projectId, uid, task.taskId);
          }
        }
        // Task writes participate in the same original-attempt CAS via an append-only event.
        entry = { entryId: newId('err'), action: command.action, version, candidateId: null, conclusion: null,
          correction: '', retryAttemptId: null, createdAt: at };
      }
      this.db.prepare('INSERT INTO feedback_entries (project_id, uid, attempt_id, version, entry_id, entry_json) VALUES (?,?,?,?,?,?)').run(projectId, uid, command.attemptId, version, entry.entryId, encodeJson(feedbackEntrySchema.parse({ ...entry, origin })));
      const result = feedbackResultSchema.parse({ context: this.context(projectId, uid, command.attemptId), tasks: this.tasks(projectId, uid), deduplicated: false });
      this.db.prepare('INSERT INTO feedback_receipts (project_id, uid, request_id, intent_json, result_json) VALUES (?,?,?,?,?)').run(projectId, uid, command.requestId, intent, encodeJson(result));
      return result;
    });
  }
}
