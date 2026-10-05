import { expect, it } from 'vitest';
import { StudyStore, createNodeSqliteDriver } from '@sew/study-storage';
import { seedVerifiedKnowledge } from './helpers/verified-knowledge';

it('reads an ordered, project-isolated course catalog without queries per version', () => {
  const sqlite = createNodeSqliteDriver();
  let selects = 0;
  const store = StudyStore.open({
    file: ':memory:',
    driver: {
      name: sqlite.name,
      open(file) {
        const db = sqlite.open(file);
        return {
          ...db,
          prepare(sql) {
            if (/^\s*SELECT\b/i.test(sql)) selects++;
            return db.prepare(sql);
          },
        };
      },
    },
  });
  try {
    const projectId = 'catalog-project';
    store.createProject({ projectId, displayName: 'Catalog', subject: '数学' });
    store.createProject({ projectId: 'other-project', displayName: 'Other' });
    const { material } = store.importMaterial({
      projectId,
      displayName: '来源.md',
      materialType: 'md',
      rawText: '增函数的来源说明。',
    });
    const { knowledge } = seedVerifiedKnowledge(store, {
      projectId,
      name: '增函数',
      concept: '增函数的定义',
      evidence: [
        { materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' },
      ],
    });
    store.savePlanVersion(projectId, 1, 'confirmed', {
      payloadVersion: 1,
      goal: '',
      examDate: null,
      dailyMinutes: 60,
      basis: 'fixture',
      gaps: [],
      tasks: [
        {
          knowledgeId: knowledge.knowledgeId,
          name: knowledge.name,
          minutes: 30,
          acceptance: '',
          evidence: [{ materialId: material.materialId, segmentId: 'S001' }],
        },
      ],
      confirmedTaskKnowledgeIds: [knowledge.knowledgeId],
    });
    const bundle = store.buildLessonBundle(
      projectId,
      [{ knowledgeId: knowledge.knowledgeId, text: knowledge.concept, conditions: '' }],
      [],
    );
    for (let course = 0; course < 3; course++) {
      let lessonId: string | null = null;
      for (let version = 0; version < 8; version++) {
        const lesson = store.createLessonDraft({
          projectId,
          lessonId,
          title: `课程 ${course}`,
          bundleId: bundle.bundleId,
          statementIds: [bundle.bundle.statements[0]!.statementId],
          questionIds: [],
        });
        lessonId = lesson.lessonId;
        if (version === 0) {
          store.reviewLesson({
            projectId,
            lessonId,
            version: lesson.version,
            decision: 'approved',
            note: 'review fixture',
          });
          store.publishLesson({ projectId, lessonId, version: lesson.version });
        }
      }
    }
    const lessons = store.listLessons(projectId);
    const versions = lessons.flatMap((lesson) =>
      store.listLessonVersions(lesson.lessonId, projectId),
    );
    const expected = {
      bundles: store.listEvidenceBundles(projectId),
      lessons,
      versions,
      reviews: versions.flatMap((version) => {
        const row = store.getLessonReview(version.lessonId, version.version, projectId);
        return row ? [row] : [];
      }),
      links: lessons.flatMap((lesson) => {
        const row = store.getLessonClassroomLink(lesson.lessonId, projectId);
        return row ? [row] : [];
      }),
    };
    selects = 0;
    expect(store.readLessonCatalog(projectId)).toEqual(expected);
    expect(selects).toBeLessThanOrEqual(6);
    expect(versions).toHaveLength(24);
    expect(store.readLessonCatalog('other-project')).toEqual({
      bundles: [],
      lessons: [],
      versions: [],
      reviews: [],
      links: [],
    });
  } finally {
    store.close();
  }
});
