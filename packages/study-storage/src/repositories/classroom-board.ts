import { z } from 'zod';
import { StudyError, newId, classroomBoardBindingSchema, classroomBoardContentSchema,
  classroomBoardItemSchema, classroomBoardEffectSchema, classroomBoardItemResultSchema, classroomBoardPlayResultSchema,
  type ClassroomBoardBindingDto, type ClassroomBoardContentDto, type ClassroomBoardItemDto, type ClassroomBoardStateDto } from '@sew/study-contracts';
import type { SqlDatabase } from '../driver';
import { encodeJson } from '../json-codec';
import { readRequiredJsonColumn, type Row } from './types';

export interface CreateClassroomBoardInput extends ClassroomBoardBindingDto { actor: string; requestId: string; content: ClassroomBoardContentDto }
export interface ReviewClassroomBoardInput { projectId: string; actor: string; requestId: string; itemId: string; expectedVersion: number; decision: 'approved' | 'rejected'; semanticReviewed: true; note: string }
export interface PlayClassroomBoardInput { projectId: string; actor: string; requestId: string; sessionId: string; itemId: string; expectedVersion: number; expectedSeq: number }
const authoritative = <T>(value: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>, column: string): T => {
  return readRequiredJsonColumn(value, schema, column, { reason: 'invalid_board_json', column });
};
const itemBinding = (item: ClassroomBoardItemDto): ClassroomBoardBindingDto => ({
  projectId: item.projectId, lessonId: item.lessonId, lessonVersion: item.lessonVersion, sceneId: item.sceneId, statementIds: item.statementIds,
});
export class ClassroomBoardRepository {
  constructor(private readonly db: SqlDatabase, private readonly facts: {
    assertBinding: (binding: ClassroomBoardBindingDto, content: ClassroomBoardContentDto) => void;
    assertPlayable: (sessionId: string, binding: ClassroomBoardBindingDto) => void;
    sessionBinding: (projectId: string, sessionId: string) => { lessonId: string; lessonVersion: number };
  }) {}
  private actor(actual: string, expected: 'local_user' | 'teacher') {
    if (actual !== expected) throw new StudyError('INVALID_ARGUMENT', { reason: 'board_actor_forbidden' });
  }
  private retry<T>(input: { projectId: string; requestId: string }, action: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | null {
    if (!input.requestId.trim() || input.requestId.length > 200) throw new StudyError('INVALID_ARGUMENT', { reason: 'board_nonce_invalid' });
    const row = this.db.prepare('SELECT * FROM classroom_board_receipts WHERE project_id=? AND request_id=?').get(input.projectId, input.requestId) as Row | undefined;
    if (!row) return null;
    if (row['action'] !== action || row['intent_json'] !== encodeJson(input)) throw new StudyError('VERSION_CONFLICT', { reason: 'board_nonce_reused' });
    return authoritative(row['result_json'], schema, 'classroom_board_receipts');
  }
  private receipt(input: { projectId: string; requestId: string }, action: string, result: unknown) {
    this.db.prepare('INSERT INTO classroom_board_receipts (project_id, request_id, action, intent_json, result_json) VALUES (?,?,?,?,?)').run(input.projectId, input.requestId, action, encodeJson(input), encodeJson(result));
  }
  getItem(projectId: string, itemId: string): ClassroomBoardItemDto | null {
    const row = this.db.prepare('SELECT item_json FROM classroom_board_items WHERE project_id=? AND item_id=?').get(projectId, itemId) as Row | undefined;
    return row ? authoritative(row['item_json'], classroomBoardItemSchema, 'classroom_board_items') : null;
  }
  listItems(projectId: string, lessonId: string, lessonVersion: number): ClassroomBoardItemDto[] {
    return (this.db.prepare('SELECT item_json FROM classroom_board_items WHERE project_id=? AND lesson_id=? AND lesson_version=? ORDER BY rowid').all(projectId, lessonId, lessonVersion) as Row[])
      .map(row => authoritative(row['item_json'], classroomBoardItemSchema, 'classroom_board_items'));
  }
  create(input: CreateClassroomBoardInput) {
    this.actor(input.actor, 'local_user');
    const old = this.retry(input, 'create', classroomBoardItemResultSchema); if (old) return { ...old, deduplicated: true };
    const binding = classroomBoardBindingSchema.parse({ projectId: input.projectId, lessonId: input.lessonId, lessonVersion: input.lessonVersion, sceneId: input.sceneId, statementIds: input.statementIds });
    const content = classroomBoardContentSchema.parse(input.content);
    if (content.kind === 'highlight' && !binding.statementIds.includes(content.statementId)) throw new StudyError('INVALID_ARGUMENT', { reason: 'board_highlight_unbound' });
    return this.db.transaction(() => {
      this.facts.assertBinding(binding, content);
      const now = new Date().toISOString();
      const item = classroomBoardItemSchema.parse({ ...binding, content, itemId: newId('board'), version: 1, status: 'draft', reviewNote: '', createdAt: now, updatedAt: now });
      this.db.prepare('INSERT INTO classroom_board_items (item_id, project_id, lesson_id, lesson_version, item_json) VALUES (?,?,?,?,?)').run(item.itemId, item.projectId, item.lessonId, item.lessonVersion, encodeJson(item));
      const result = { item, deduplicated: false }; this.receipt(input, 'create', result); return result;
    });
  }
  review(input: ReviewClassroomBoardInput) {
    this.actor(input.actor, 'local_user');
    const old = this.retry(input, 'review', classroomBoardItemResultSchema); if (old) return { ...old, deduplicated: true };
    return this.db.transaction(() => {
      const item = this.getItem(input.projectId, input.itemId);
      if (!item) throw new StudyError('NOT_FOUND', { itemId: input.itemId });
      if (item.version !== input.expectedVersion || item.status !== 'draft') throw new StudyError('VERSION_CONFLICT', { reason: 'board_review_stale' });
      if (input.semanticReviewed !== true || !input.note.trim()) throw new StudyError('INVALID_ARGUMENT', { reason: 'board_semantic_review_required' });
      this.facts.assertBinding(itemBinding(item), item.content);
      const updated = classroomBoardItemSchema.parse({ ...item, version: item.version + 1, status: input.decision, reviewNote: input.note, updatedAt: new Date().toISOString() });
      this.db.prepare('UPDATE classroom_board_items SET item_json=? WHERE project_id=? AND item_id=?').run(encodeJson(updated), input.projectId, input.itemId);
      const result = { item: updated, deduplicated: false }; this.receipt(input, 'review', result); return result;
    });
  }
  getPlayReceipt(input: PlayClassroomBoardInput) {
    this.actor(input.actor, 'teacher');
    const old = this.retry(input, 'play', classroomBoardPlayResultSchema);
    return old ? { ...old, deduplicated: true } : null;
  }
  play(input: PlayClassroomBoardInput) {
    this.actor(input.actor, 'teacher');
    const old = this.retry(input, 'play', classroomBoardPlayResultSchema); if (old) return { ...old, deduplicated: true };
    return this.db.transaction(() => {
      const item = this.getItem(input.projectId, input.itemId);
      if (!item) throw new StudyError('NOT_FOUND', { itemId: input.itemId });
      if (item.version !== input.expectedVersion || item.status !== 'approved') throw new StudyError('VERSION_CONFLICT', { reason: 'board_not_approved_or_stale' });
      const binding = itemBinding(item);
      this.facts.assertBinding(binding, item.content); this.facts.assertPlayable(input.sessionId, binding);
      const state = this.state(input.projectId, input.sessionId);
      if (state.seq !== input.expectedSeq) throw new StudyError('VERSION_CONFLICT', { reason: 'board_sequence_stale' });
      if (state.effects.some(effect => effect.item.itemId === item.itemId)) throw new StudyError('STEP_ALREADY_COMMITTED', { reason: 'board_item_already_played' });
      const effect = classroomBoardEffectSchema.parse({ projectId: input.projectId, sessionId: input.sessionId, seq: state.seq + 1, item, actor: 'teacher', at: new Date().toISOString() });
      this.db.prepare('INSERT INTO classroom_board_effects (project_id, session_id, seq, item_id, effect_json) VALUES (?,?,?,?,?)').run(input.projectId, input.sessionId, effect.seq, item.itemId, encodeJson(effect));
      const result = { effect, deduplicated: false }; this.receipt(input, 'play', result); return result;
    });
  }
  /** Historical effects are read without re-executing or requiring still-live sources. */
  state(projectId: string, sessionId: string): ClassroomBoardStateDto {
    const binding = this.facts.sessionBinding(projectId, sessionId);
    const effects = (this.db.prepare('SELECT effect_json FROM classroom_board_effects WHERE project_id=? AND session_id=? ORDER BY seq').all(projectId, sessionId) as Row[])
      .map(row => authoritative(row['effect_json'], classroomBoardEffectSchema, 'classroom_board_effects'));
    if (effects.some((effect, index) => effect.seq !== index + 1 || effect.projectId !== projectId || effect.sessionId !== sessionId
      || effect.item.lessonId !== binding.lessonId || effect.item.lessonVersion !== binding.lessonVersion)) {
      throw new StudyError('INTERNAL', { reason: 'board_history_binding_or_sequence_invalid' });
    }
    return { sessionId, seq: effects.at(-1)?.seq ?? 0, effects, items: this.listItems(projectId, binding.lessonId, binding.lessonVersion) };
  }
}
