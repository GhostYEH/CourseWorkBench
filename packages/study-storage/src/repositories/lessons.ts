/**
 * 证据包与课程版本（repository，LESSON-01）。
 *
 * 证据包按内容摘要去重冻结；课程版本只追加不覆写：修改课件得到新的草案版本，
 * 发布时把上一个已发布版本转为 superseded，并同步 v1 就预留的 `classroom_links`
 * 课程↔stage 侧表。JSON 列都按权威列读取，损坏即拒绝。
 */

import { StudyError, newId, type EvidenceBundleDto, type LessonReviewDecision } from '@sew/study-contracts';
import { LESSON_REVIEW_DECISION, LESSON_STATUS } from '@sew/study-contracts';
import {
  assertLessonPublishable, lessonReferencedKnowledgeIds, nextLessonVersion,
} from '@sew/study-domain';
import type { SqlDatabase } from '../driver';
import { encodeJson, evidenceBundleSchema, knowledgeIdsSchema } from '../json-codec';
import {
  defaultJsonPolicy,
  num,
  readAuthoritativeJsonColumn,
  str,
  type ClassroomLinkRow,
  type EvidenceBundleRow,
  type LessonReviewRow,
  type LessonStatus,
  type LessonVersionRow,
  type Row,
} from './types';

export interface CreateLessonDraftInput {
  projectId: string;
  /** null 表示新建课程；给出 lessonId 表示在同一课程下追加新的草案版本。 */
  lessonId: string | null;
  title: string;
  bundleId: string;
  statementIds: string[];
  questionIds: string[];
}

export interface PublishLessonInput {
  projectId: string;
  lessonId: string;
  version: number;
  /** 允许只发布课程而不带课堂文档；带文档时同时写入 stage 映射。 */
  stageId?: string | null;
  stageDocumentVersion?: number | null;
  documentDigest?: string | null;
}

const mapBundle = (row: Row): EvidenceBundleRow => {
  const bundleId = str(row['bundle_id']);
  return {
    bundleId,
    projectId: str(row['project_id']),
    digest: str(row['digest']),
    frozenAt: str(row['frozen_at']),
    bundle: readAuthoritativeJsonColumn(
      row['bundle_json'],
      evidenceBundleSchema,
      `evidence_bundles.bundle_json[${bundleId}]`,
      defaultJsonPolicy,
    ),
  };
};

const mapLesson = (row: Row): LessonVersionRow => {
  const lessonId = str(row['lesson_id']);
  const readIds = (column: string): string[] => readAuthoritativeJsonColumn(
    row[column],
    knowledgeIdsSchema,
    `lesson_versions.${column}[${lessonId}#${num(row['version'])}]`,
    defaultJsonPolicy,
  );
  return {
    lessonId,
    version: num(row['version']),
    projectId: str(row['project_id']),
    title: str(row['title']),
    status: mapLessonStatus(str(row['status'])),
    bundleId: str(row['bundle_id']),
    bundleDigest: str(row['bundle_digest']),
    statementIds: readIds('statement_ids_json'),
    questionIds: readIds('question_ids_json'),
    createdAt: str(row['created_at']),
    updatedAt: str(row['updated_at']),
  };
};

export function mapLessonStatus(value: string): LessonStatus {
  if ((LESSON_STATUS as readonly string[]).includes(value)) return value as LessonStatus;
  throw new StudyError('INTERNAL', { reason: 'invalid_lesson_status', status: value });
}

const mapLessonReviewDecision = (value: string): LessonReviewDecision => {
  if ((LESSON_REVIEW_DECISION as readonly string[]).includes(value)) return value as LessonReviewDecision;
  throw new StudyError('INTERNAL', { reason: 'invalid_lesson_review_decision', decision: value });
};

const mapReview = (row: Row): LessonReviewRow => {
  const lessonId = str(row['lesson_id']);
  const version = num(row['version']);
  const readIds = (column: string): string[] => readAuthoritativeJsonColumn(
    row[column],
    knowledgeIdsSchema,
    `lesson_reviews.${column}[${lessonId}#${version}]`,
    defaultJsonPolicy,
  );
  return {
    projectId: str(row['project_id']),
    lessonId,
    version,
    decision: mapLessonReviewDecision(str(row['decision'])),
    note: str(row['note']),
    admittedKnowledgeIds: readIds('admitted_json'),
    blockedKnowledgeIds: readIds('blocked_json'),
    reviewedAt: str(row['reviewed_at']),
  };
};

export class LessonRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** 冻结证据包：同一项目内摘要相同即返回既有记录，不产生第二份。 */
  saveBundle(projectId: string, bundle: EvidenceBundleDto, digest: string): EvidenceBundleRow {
    const existing = this.db
      .prepare('SELECT * FROM evidence_bundles WHERE project_id = ? AND digest = ?')
      .get(projectId, digest) as Row | undefined;
    if (existing) return mapBundle(existing);

    const bundleId = newId<'bundle'>('bundle');
    this.db
      .prepare('INSERT INTO evidence_bundles (bundle_id, project_id, digest, bundle_json, frozen_at) VALUES (?, ?, ?, ?, ?)')
      .run(bundleId, projectId, digest, encodeJson(bundle), new Date().toISOString());
    const saved = this.getBundle(bundleId, projectId);
    if (!saved) throw new StudyError('INTERNAL', { bundleId });
    return saved;
  }

  getBundle(bundleId: string, projectId: string): EvidenceBundleRow | null {
    const row = this.db
      .prepare('SELECT * FROM evidence_bundles WHERE bundle_id = ? AND project_id = ?')
      .get(bundleId, projectId) as Row | undefined;
    return row ? mapBundle(row) : null;
  }

  listBundles(projectId: string): EvidenceBundleRow[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence_bundles WHERE project_id = ? ORDER BY frozen_at DESC, bundle_id')
      .all(projectId) as Row[];
    return rows.map(mapBundle);
  }

  latestBundle(projectId: string): EvidenceBundleRow | null {
    return this.listBundles(projectId)[0] ?? null;
  }

  listVersions(lessonId: string, projectId: string): LessonVersionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM lesson_versions WHERE lesson_id = ? AND project_id = ? ORDER BY version DESC')
      .all(lessonId, projectId) as Row[];
    return rows.map(mapLesson);
  }

  listLessons(projectId: string): LessonVersionRow[] {
    const rows = this.db
      .prepare(
        `SELECT lesson.* FROM lesson_versions AS lesson
          WHERE lesson.project_id = ?
            AND lesson.version = (SELECT MAX(version) FROM lesson_versions AS later
                                   WHERE later.lesson_id = lesson.lesson_id AND later.project_id = lesson.project_id)
          ORDER BY lesson.updated_at DESC, lesson.lesson_id`,
      )
      .all(projectId) as Row[];
    return rows.map(mapLesson);
  }

  getVersion(lessonId: string, version: number, projectId: string): LessonVersionRow | null {
    const row = this.db
      .prepare('SELECT * FROM lesson_versions WHERE lesson_id = ? AND version = ? AND project_id = ?')
      .get(lessonId, version, projectId) as Row | undefined;
    return row ? mapLesson(row) : null;
  }

  /** 新建或追加草案版本；返回的 lessonId 供后续修订复用同一课程身份。 */
  createDraft(input: CreateLessonDraftInput): LessonVersionRow {
    const bundle = this.getBundle(input.bundleId, input.projectId);
    if (!bundle) throw new StudyError('NOT_FOUND', { bundleId: input.bundleId });
    const lessonId = input.lessonId ?? newId<'lesson'>('lesson');
    if (input.lessonId) {
      const owned = this.listVersions(input.lessonId, input.projectId);
      if (owned.length === 0) throw new StudyError('NOT_FOUND', { lessonId: input.lessonId });
    }
    const version = nextLessonVersion(this.listVersions(lessonId, input.projectId).map((row) => row.version));
    const statementIds = [...new Set(input.statementIds)];
    const unknown = statementIds.filter(
      (id) => !bundle.bundle.statements.some((statement) => statement.statementId === id),
    );
    if (statementIds.length === 0 || unknown.length > 0) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'statement_outside_bundle', unknown });
    }
    const questionIds = [...new Set(input.questionIds)];
    const unknownQuestions = questionIds.filter(
      (id) => !bundle.bundle.questions.some((question) => question.questionId === id),
    );
    if (unknownQuestions.length > 0) {
      throw new StudyError('INVALID_ARGUMENT', { reason: 'question_outside_bundle', unknownQuestions });
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO lesson_versions (lesson_id, version, project_id, title, status, bundle_id, bundle_digest, statement_ids_json, question_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lessonId,
        version,
        input.projectId,
        input.title,
        input.bundleId,
        bundle.digest,
        encodeJson(statementIds),
        encodeJson(questionIds),
        now,
        now,
      );
    const created = this.getVersion(lessonId, version, input.projectId);
    if (!created) throw new StudyError('INTERNAL', { lessonId, version });
    return created;
  }

  /**
   * 发布课程：在同一个事务内复核「已审核 + 准入」，转换旧版本状态并写课程↔stage 侧表。
   *
   * `reviewApproved` 与 `admittedKnowledgeIds` 由调用方（StudyStore）提供，本层不自行判断。
   */
  publish(
    input: PublishLessonInput,
    deps: {
      admittedKnowledgeIds: ReadonlySet<string>;
      reviewApproved: boolean;
      statementKnowledgeOf: (statementId: string) => string | null;
      questionKnowledgeOf: (questionId: string) => string[];
    },
  ): LessonVersionRow {
    const lesson = this.getVersion(input.lessonId, input.version, input.projectId);
    if (!lesson) throw new StudyError('NOT_FOUND', { lessonId: input.lessonId, version: input.version });
    assertLessonPublishable(
      {
        status: lesson.status,
        reviewApproved: deps.reviewApproved,
        referencedKnowledgeIds: lessonReferencedKnowledgeIds(lesson, deps),
      },
      deps.admittedKnowledgeIds,
    );

    const now = new Date().toISOString();
    this.db.transaction(() => {
      // 同一课程只保留一个当前已发布版本；其他课程（同项目可有多课时）不受影响。
      this.db
        .prepare("UPDATE lesson_versions SET status = 'superseded', updated_at = ? WHERE project_id = ? AND lesson_id = ? AND status = 'published'")
        .run(now, input.projectId, input.lessonId);
      this.db
        .prepare("UPDATE lesson_versions SET status = 'published', updated_at = ? WHERE lesson_id = ? AND version = ? AND project_id = ?")
        .run(now, input.lessonId, input.version, input.projectId);
      this.upsertLink(input, lesson.bundleId, now);
    });

    const published = this.getVersion(input.lessonId, input.version, input.projectId);
    if (!published) throw new StudyError('INTERNAL', { lessonId: input.lessonId, version: input.version });
    return published;
  }

  /** 当前已发布的版本；没有则返回 null。撤回与课堂入口都以这一条为准。 */
  publishedVersion(lessonId: string, projectId: string): LessonVersionRow | null {
    const row = this.db
      .prepare("SELECT * FROM lesson_versions WHERE lesson_id = ? AND project_id = ? AND status = 'published'")
      .get(lessonId, projectId) as Row | undefined;
    return row ? mapLesson(row) : null;
  }

  /**
   * 主动停用已发布课程：版本状态记 withdrawn（与被新版本取代不同），
   * 侧表同步停用并保留可读原因，课堂入口随即受阻。
   */
  withdraw(input: { projectId: string; lessonId: string; version: number; reason: string }): LessonVersionRow {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const result = this.db
        .prepare("UPDATE lesson_versions SET status = 'withdrawn', updated_at = ? WHERE lesson_id = ? AND version = ? AND project_id = ? AND status = 'published'")
        .run(now, input.lessonId, input.version, input.projectId);
      if (result.changes !== 1) {
        throw new StudyError('STEP_ALREADY_COMMITTED', { reason: 'lesson_not_published' });
      }
      this.db
        .prepare("UPDATE classroom_links SET status = 'withdrawn', status_note = ?, updated_at = ? WHERE lesson_id = ? AND project_id = ?")
        .run(input.reason, now, input.lessonId, input.projectId);
    });
    const withdrawn = this.getVersion(input.lessonId, input.version, input.projectId);
    if (!withdrawn) throw new StudyError('INTERNAL', { lessonId: input.lessonId, version: input.version });
    return withdrawn;
  }

  /**
   * 记录课程版本的审核结论。重复审核同一版本按更新处理：审核人改判不必等新版本，
   * 但新草案版本仍需一条自己的记录，旧结论不会顺延。
   */
  recordReview(input: {
    projectId: string;
    lessonId: string;
    version: number;
    decision: LessonReviewDecision;
    note: string;
    admittedKnowledgeIds: string[];
    blockedKnowledgeIds: string[];
  }): LessonReviewRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO lesson_reviews (project_id, lesson_id, version, decision, note, admitted_json, blocked_json, reviewed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, lesson_id, version)
         DO UPDATE SET decision = excluded.decision, note = excluded.note,
                       admitted_json = excluded.admitted_json, blocked_json = excluded.blocked_json,
                       reviewed_at = excluded.reviewed_at`,
      )
      .run(
        input.projectId,
        input.lessonId,
        input.version,
        input.decision,
        input.note,
        encodeJson([...new Set(input.admittedKnowledgeIds)]),
        encodeJson([...new Set(input.blockedKnowledgeIds)]),
        now,
      );
    const saved = this.getReview(input.lessonId, input.version, input.projectId);
    if (!saved) throw new StudyError('INTERNAL', { lessonId: input.lessonId, version: input.version });
    return saved;
  }

  getReview(lessonId: string, version: number, projectId: string): LessonReviewRow | null {
    const row = this.db
      .prepare('SELECT * FROM lesson_reviews WHERE lesson_id = ? AND version = ? AND project_id = ?')
      .get(lessonId, version, projectId) as Row | undefined;
    return row ? mapReview(row) : null;
  }

  /** 课程↔stage 一对一映射：没有课堂文档时也要留下课程已发布的记录。 */
  private upsertLink(input: PublishLessonInput, bundleId: string, now: string): void {
    const existing = this.db
      .prepare('SELECT lesson_id FROM classroom_links WHERE lesson_id = ? AND project_id = ?')
      .get(input.lessonId, input.projectId) as Row | undefined;
    if (existing) {
      this.db
        .prepare('UPDATE classroom_links SET lesson_version = ?, stage_id = ?, stage_document_version = ?, document_digest = ?, evidence_bundle_id = ?, status = ?, status_note = ?, updated_at = ? WHERE lesson_id = ? AND project_id = ?')
        .run(
          input.version,
          input.stageId ?? null,
          input.stageDocumentVersion ?? null,
          input.documentDigest ?? null,
          bundleId,
          'published',
          '',
          now,
          input.lessonId,
          input.projectId,
        );
      return;
    }
    this.db
      .prepare(
        `INSERT INTO classroom_links (lesson_id, project_id, lesson_version, stage_id, stage_document_version, document_digest, evidence_bundle_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`,
      )
      .run(
        input.lessonId,
        input.projectId,
        input.version,
        input.stageId ?? null,
        input.stageDocumentVersion ?? null,
        input.documentDigest ?? null,
        bundleId,
        now,
        now,
      );
  }

  /**
   * 把已装配的课件文档挂到「当前已发布的这个版本」上。
   *
   * 只更新课堂映射，不改课程状态：课件文本全部来自该版本已审核并冻结的证据包，
   * 挂接动作不产生新的学科事实，因此不需要新的审核结论，但仍要求版本仍处发布态。
   */
  attachDocument(input: {
    projectId: string;
    lessonId: string;
    version: number;
    stageId: string;
    documentDigest: string;
  }): ClassroomLinkRow {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE classroom_links SET stage_id = ?, stage_document_version = ?, document_digest = ?, updated_at = ? WHERE lesson_id = ? AND project_id = ? AND lesson_version = ? AND status = ?')
      .run(input.stageId, 1, input.documentDigest, now, input.lessonId, input.projectId, input.version, 'published');
    if (result.changes !== 1) {
      throw new StudyError('STEP_ALREADY_COMMITTED', {
        reason: 'lesson_not_currently_published', lessonId: input.lessonId, version: input.version,
      });
    }
    const link = this.getLink(input.lessonId, input.projectId);
    if (!link) throw new StudyError('INTERNAL', { lessonId: input.lessonId });
    return link;
  }

  getLink(lessonId: string, projectId: string): ClassroomLinkRow | null {    const row = this.db
      .prepare('SELECT * FROM classroom_links WHERE lesson_id = ? AND project_id = ?')
      .get(lessonId, projectId) as Row | undefined;
    if (!row) return null;
    const stageDocumentVersion = num(row['stage_document_version']);
    return {
      lessonId: str(row['lesson_id']),
      projectId: str(row['project_id']),
      lessonVersion: num(row['lesson_version']),
      stageId: str(row['stage_id']) || null,
      stageDocumentVersion: stageDocumentVersion > 0 ? stageDocumentVersion : null,
      documentDigest: str(row['document_digest']) || null,
      evidenceBundleId: str(row['evidence_bundle_id']) || null,
      status: mapLessonStatus(str(row['status'])),
      statusNote: str(row['status_note']),
      createdAt: str(row['created_at']),
      updatedAt: str(row['updated_at']),
    };
  }
}
