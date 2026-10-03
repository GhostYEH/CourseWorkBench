import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeSqliteDriver } from '@sew/study-storage';
import { MIGRATIONS } from '../packages/study-storage/src/schema';
import { ensureFixedLesson, reviewedLesson } from '../apps/learning/lib/server/classroom-service';
import { closeProject, openProjectFromDisk } from '../apps/learning/lib/server/service';
import { GET as getAttempts } from '../apps/learning/app/api/study/attempts/route';
import { FIXED_KNOWLEDGE, FIXED_MATERIAL, FIXED_REVIEW } from '../apps/learning/lib/classroom/reviewed-lesson';
import { DEMO_IMAGE_SHA256, DEMO_FONT_SHA256, DEMO_IMAGE_REF, DEMO_FONT_REF } from '../apps/learning/lib/classroom/demo-asset-refs';

const DEMO_SOURCE_FINGERPRINT = '930a44aedfa0e4f45179a2ed22cf532b0ef30c4db651cb049e96312855e8cad4';
const DEMO_DOCUMENT_DIGEST = '0ae3baa37c31bf04ff166a27ac6502600bfd5991445e54586c876c853797e563';

describe('正式与演示记录机器分区', () => {
  let root: string | undefined;

  afterEach(() => {
    closeProject();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('演示课件走编者来源，不进入正式工作台、覆盖统计或本人掌握', async () => {
    root = mkdtempSync(join(tmpdir(), 'sew-record-scope-'));
    const session = openProjectFromDisk(root);
    ensureFixedLesson(session);

    const demo = session.store.listKnowledge('demo');
    expect(demo).toHaveLength(1);
    expect(demo[0]?.reviewProvenance).toBe('demo_author');
    expect(session.store.listKnowledge()).toEqual([]);
    expect(session.store.listMaterials()).toEqual([]);
    expect(session.store.listProposals()).toEqual([]);
    expect(session.store.checkAdmission([demo[0]!.knowledgeId]).allowed).toBe(false);
    expect(session.store.checkAdmission([demo[0]!.knowledgeId], 'demo').allowed).toBe(true);

    const question = session.store.listQuestions('demo')[0]!;
    expect(question.recordScope).toBe('demo');
    const input = {
      projectId: session.projectId,
      questionId: question.questionId,
      idempotencyKey: 'demo-human-attempt-1',
      actorType: 'human_learner',
      answerText: question.answer,
      processText: '演示课堂作答',
      kind: 'real',
    } as const;
    const submitted = session.store.submitAttempt(input);
    expect(submitted.attempt).toMatchObject({ recordScope: 'demo', kind: 'real', actorType: 'human_learner', masteryAfter: null });
    expect(session.store.submitAttempt(input).deduplicated).toBe(true);
    expect(session.store.countAttemptKinds()).toEqual({ real: 0, simulation: 0 });
    expect(session.store.listAttempts('real')).toEqual([]);
    expect(session.store.listAttempts('real', 'demo')).toHaveLength(1);
    const formalResponse = await getAttempts(new Request('http://service.local/api/study/attempts?kind=real'));
    const demoResponse = await getAttempts(new Request('http://service.local/api/study/attempts?kind=real&recordScope=demo'));
    expect((await formalResponse.json() as { data: { attempts: unknown[] } }).data.attempts).toEqual([]);
    expect((await demoResponse.json() as { data: { attempts: { recordScope: string }[] } }).data.attempts)
      .toMatchObject([{ recordScope: 'demo' }]);
    expect(session.store.getKnowledge(demo[0]!.knowledgeId, 'demo')?.masteryStatus).toBe('untested');
    expect(session.store.getClassroomDocument(session.projectId, reviewedLesson.stageId)?.recordScope).toBe('demo');

    // A user import with the same title is a separate formal material and cannot mutate the demo revision.
    session.store.importMaterial({
      projectId: session.projectId,
      displayName: FIXED_MATERIAL.displayName,
      materialType: 'md',
      readableLocation: 'test:formal-same-title',
      rawText: '与演示材料标题相同但内容不同的正式材料。',
    });
    expect(session.store.listMaterials()).toHaveLength(1);
    expect(session.store.listMaterials('demo')[0]?.fingerprint).toBe(DEMO_SOURCE_FINGERPRINT);
    expect(session.store.listKnowledge('demo')[0]?.sourceStatus).toBe('verified');
  });

  it('删除课堂文档只释放该文档绑定，不隐式删除资源字节', () => {
    root = mkdtempSync(join(tmpdir(), 'sew-record-scope-'));
    const session = openProjectFromDisk(root);
    ensureFixedLesson(session);
    const binding = session.store.listClassroomAssetBindings(session.projectId, reviewedLesson.stageId)[0]!;
    const asset = session.store.getClassroomAsset(session.projectId, binding.assetId)!;

    session.store.deleteClassroomDocument(session.projectId, reviewedLesson.stageId);

    expect(session.store.listClassroomAssetBindings(session.projectId, reviewedLesson.stageId)).toEqual([]);
    expect(session.store.getClassroomAsset(session.projectId, binding.assetId)?.bytes).toEqual(asset.bytes);
    session.store.deleteClassroomAsset(session.projectId, binding.assetId);
    expect(session.store.getClassroomAsset(session.projectId, binding.assetId)).toBeNull();
  });

  it('v6 legacy migration只标记具备精确文件、知识和编者审核链的旧演示束', () => {
    root = mkdtempSync(join(tmpdir(), 'sew-record-scope-legacy-'));
    const databaseFile = join(root, 'legacy.sqlite');
    const db = createNodeSqliteDriver().open(databaseFile);
    try {
      for (const migration of MIGRATIONS.filter((item) => item.version <= 6)) db.exec(migration.sql);
      const evidence = [
        { materialId: 'demo-mat', revision: 1, segmentId: 'S003', use: 'concept_basis', fingerprint: '1', excerpt: '原文定义' },
        { materialId: 'demo-mat', revision: 1, segmentId: 'S004', use: 'method_basis', fingerprint: '2', excerpt: '原文方法' },
      ];
      db.prepare(`INSERT INTO source_versions
        (material_id, revision, display_name, material_type, readable_location, imported_at, normalization_version, fingerprint, normalized_text, segment_count)
        VALUES (?, 1, ?, 'md', ?, '2026-01-01', 'norm-1', ?, 'legacy text', 4)`)
        .run('demo-mat', FIXED_MATERIAL.displayName, FIXED_MATERIAL.readableLocation, DEMO_SOURCE_FINGERPRINT);
      // A later revision under the same material ID is a separate authority record.
      db.prepare(`INSERT INTO source_versions
        (material_id, revision, display_name, material_type, readable_location, imported_at, normalization_version, fingerprint, normalized_text, segment_count)
        VALUES (?, 2, ?, 'md', 'user import', '2026-01-02', 'norm-1', 'later-formal-revision', 'formal later revision', 1)`)
        .run('demo-mat', FIXED_MATERIAL.displayName);
      // Same title alone must not change this unrelated material's formal scope.
      db.prepare(`INSERT INTO source_versions
        (material_id, revision, display_name, material_type, readable_location, imported_at, normalization_version, fingerprint, normalized_text, segment_count)
        VALUES ('formal-decoy', 1, ?, 'md', 'user import', '2026-01-01', 'norm-1', 'wrong-fingerprint', 'not demo', 1)`)
        .run(FIXED_MATERIAL.displayName);
      db.prepare(`INSERT INTO proposals
        (proposal_id, name, concept, conditions, scope_status, prerequisites_json, evidence_json, acceptance, priority, proposed_by, status, mechanical_json, review_note, created_at, reviewed_at, revision)
        VALUES ('demo-proposal', ?, ?, ?, 'in_syllabus', '[]', ?, ?, 'high', 'user', 'approved', '{}', ?, '2026-01-01', '2026-01-01', 1)`)
        .run(FIXED_KNOWLEDGE.name, FIXED_KNOWLEDGE.concept, FIXED_KNOWLEDGE.conditions, JSON.stringify(evidence), FIXED_KNOWLEDGE.acceptance, FIXED_REVIEW.reviewNote);
      db.prepare(`INSERT INTO knowledge_points
        (knowledge_id, name, concept, conditions, source_status, scope_status, mastery_status, prerequisites_json, evidence_json, acceptance, priority, origin_proposal_id, revision, created_at, updated_at)
        VALUES ('demo-kp', ?, ?, ?, 'verified', 'in_syllabus', 'passed', '[]', ?, ?, 'high', 'demo-proposal', 0, '2026-01-01', '2026-01-01')`)
        .run(FIXED_KNOWLEDGE.name, FIXED_KNOWLEDGE.concept, FIXED_KNOWLEDGE.conditions, JSON.stringify(evidence), FIXED_KNOWLEDGE.acceptance);
      db.prepare(`INSERT INTO knowledge_points
        (knowledge_id, name, concept, conditions, source_status, scope_status, mastery_status, prerequisites_json, evidence_json, acceptance, priority, origin_proposal_id, revision, created_at, updated_at)
        VALUES ('same-name-decoy', ?, 'unrelated content', '', 'verified', 'in_syllabus', 'untested', '[]', '[]', '', 'medium', NULL, 0, '2026-01-01', '2026-01-01')`)
        .run(FIXED_KNOWLEDGE.name);
      db.prepare(`INSERT INTO classroom_documents
        (stage_id, project_id, lesson_id, dsl_version, document_json, digest, scene_count, created_at, updated_at)
        VALUES ('stage-demo-monotonicity-1', 'project-demo', 'lesson-demo-monotonicity-1', '1', '{}', ?, 3, '2026-01-01', '2026-01-01')`)
        .run(DEMO_DOCUMENT_DIGEST);
      db.prepare(`INSERT INTO classroom_scene_sources
        (project_id, stage_id, scene_id, knowledge_ids_json, question_id, reviewed_by, review_note, created_at, updated_at)
        VALUES ('project-demo', 'stage-demo-monotonicity-1', 'scene-quiz-single', '["demo-kp","same-name-decoy"]', 'demo-question', ?, ?, '2026-01-01', '2026-01-01')`)
        .run(FIXED_REVIEW.reviewedBy, FIXED_REVIEW.reviewNote);
      db.prepare(`INSERT INTO questions
        (question_id, stem, answer, solution, knowledge_ids_json, origin, origin_label, origin_detail, origin_record_json, revision, created_at, requested_origin, forged_exam_claim)
        VALUES ('demo-question', 'demo', 'B', 'demo answer', '["demo-kp"]', 'ai_new', 'AI 新编题', NULL, NULL, 1, '2026-01-01', 'ai_new', 0)`).run();
      for (const [assetId, mediaType, sha, symbolicRef, slot] of [
        ['legacy-image', 'image/png', DEMO_IMAGE_SHA256, DEMO_IMAGE_REF, 'hero-image'],
        ['legacy-font', 'font/ttf', DEMO_FONT_SHA256, DEMO_FONT_REF, 'formula-font'],
      ]) {
        db.prepare(`INSERT INTO classroom_assets (project_id, asset_id, media_type, metadata_json, bytes, sha256, revision, created_at, updated_at)
          VALUES ('project-demo', ?, ?, ?, X'00', ?, 1, '2026-01-01', '2026-01-01')`)
          .run(assetId, mediaType, JSON.stringify({ symbolicRef }), sha);
        db.prepare(`INSERT INTO classroom_asset_bindings
          (project_id, stage_id, scene_id, slot, asset_id, created_at, updated_at)
          VALUES ('project-demo', 'stage-demo-monotonicity-1', 'scene-slide-intro', ?, ?, '2026-01-01', '2026-01-01')`)
          .run(slot, assetId);
      }
      db.exec(MIGRATIONS.find((item) => item.version === 7)!.sql);
      expect(db.prepare('SELECT record_scope, review_provenance FROM knowledge_points WHERE knowledge_id = ?').get('demo-kp'))
        .toMatchObject({ record_scope: 'demo', review_provenance: 'demo_author' });
      expect(db.prepare('SELECT record_scope FROM knowledge_points WHERE knowledge_id = ?').get('same-name-decoy'))
        .toMatchObject({ record_scope: 'formal' });
      expect(db.prepare('SELECT record_scope FROM source_versions WHERE material_id = ?').get('formal-decoy'))
        .toMatchObject({ record_scope: 'formal' });
      expect(db.prepare('SELECT record_scope FROM source_versions WHERE material_id = ? AND revision = 1').get('demo-mat'))
        .toMatchObject({ record_scope: 'demo' });
      expect(db.prepare('SELECT record_scope FROM source_versions WHERE material_id = ? AND revision = 2').get('demo-mat'))
        .toMatchObject({ record_scope: 'formal' });
      expect(db.prepare('SELECT record_scope FROM classroom_documents WHERE project_id = ?').get('project-demo'))
        .toMatchObject({ record_scope: 'demo' });
      expect(db.prepare('SELECT record_scope FROM classroom_assets WHERE asset_id = ?').get('legacy-image'))
        .toMatchObject({ record_scope: 'demo' });
      expect(db.prepare('SELECT record_scope FROM classroom_assets WHERE asset_id = ?').get('legacy-font'))
        .toMatchObject({ record_scope: 'demo' });
      expect(db.prepare('SELECT record_scope FROM questions WHERE question_id = ?').get('demo-question'))
        .toMatchObject({ record_scope: 'demo' });
    } finally {
      db.close();
    }
  });
});
