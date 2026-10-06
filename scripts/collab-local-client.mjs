#!/usr/bin/env node
/**
 * Isolated local-client fixture for collab-two-client-link.mjs.
 *
 * Runs the real /api/study/collab/online route in a separate process with its
 * own project directory and user-data directory. The tiny loopback adapter
 * exposes only that route and injects the fixture's trusted project scope.
 */
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = process.env.SEW_PROJECT_ROOT;
if (
  !projectRoot ||
  !process.env.SEW_USER_DATA_DIR ||
  !process.env.SEW_COLLAB_SERVICE_URL ||
  !process.env.SEW_FIXTURE_UID
) {
  throw new Error('fixture requires isolated project/user directories and a collab service URL');
}

mkdirSync(process.env.SEW_USER_DATA_DIR, { recursive: true });
writeFileSync(
  join(process.env.SEW_USER_DATA_DIR, 'learner-profile.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    uid: process.env.SEW_FIXTURE_UID,
    displayName: process.env.SEW_FIXTURE_NAME ?? '隔离测试学习者',
    revision: 1,
    createdAt: new Date().toISOString(),
    registrationStatus: 'local_only',
    canInvite: false,
  })}\n`,
  { flag: 'wx' },
);

const { openProjectFromDisk } = await import('../apps/learning/lib/server/service.ts');
const { getLearnerProfile } = await import('../apps/learning/lib/server/learner-profile.ts');
const contracts = await import('@sew/study-contracts');
const domain = await import('@sew/study-domain');
const session = openProjectFromDisk(projectRoot);
const uid = getLearnerProfile().uid;

// Seed one reviewed, frozen local lesson only for the owner. The learner's
// answers and grading material stay in this local fixture database.
const store = session.store;
const projectId = session.projectId;
store.bindLocalLearner(projectId, uid);
const material = store.importMaterial({
  projectId,
  displayName: '协作公开课文',
  materialType: 'txt',
  rawText: '在同一区间内，函数值随自变量增大而增大的函数称为增函数。',
});
const proposal = store.createProposal({
  projectId,
  name: '增函数',
  concept: '函数值随自变量增大',
  conditions: '同一区间',
  scopeStatus: 'in_syllabus',
  prerequisites: [],
  evidence: [
    {
      materialId: material.material.materialId,
      revision: 1,
      segmentId: 'S001',
      use: 'concept_basis',
    },
  ],
  acceptance: '',
  priority: 'medium',
  proposedBy: 'user',
});
const knowledge = store.applyReview({
  proposalId: proposal.proposalId,
  decision: 'approved',
  expectedRevision: proposal.revision,
  semanticReviewed: true,
}).knowledgePoint;
const question = store.createQuestion({
  stem: '增函数的定义条件是什么？',
  answer: 'private-answer-fixture',
  solution: 'private-rubric-fixture',
  knowledgeIds: [knowledge.knowledgeId],
  requestedOrigin: 'ai_new',
  originRecord: null,
  assessment: {
    schemaVersion: 1,
    type: 'single',
    options: [
      { value: 'A', label: '同一区间' },
      { value: 'B', label: '任意区间' },
    ],
    correctAnswers: ['A'],
    rubric: 'private-score-fixture',
    maxScore: 1,
    answerVersion: 1,
  },
}).question;
store.savePlanVersion(projectId, 1, 'confirmed', {
  payloadVersion: 1,
  goal: '理解函数单调性',
  examDate: null,
  dailyMinutes: 30,
  tasks: [
    {
      knowledgeId: knowledge.knowledgeId,
      name: '增函数',
      minutes: 15,
      acceptance: '',
      evidence: [{ materialId: material.material.materialId, segmentId: 'S001' }],
    },
  ],
  gaps: [],
  basis: '核对本机材料',
  confirmedTaskKnowledgeIds: [knowledge.knowledgeId],
});
const bundle = store.buildLessonBundle(
  projectId,
  [{ knowledgeId: knowledge.knowledgeId, text: '函数值随自变量增大', conditions: '同一区间' }],
  [question.questionId],
);
const lesson = store.createLessonDraft({
  projectId,
  lessonId: null,
  title: '增函数课堂',
  bundleId: bundle.bundleId,
  statementIds: bundle.bundle.statements.map((item) => item.statementId),
  questionIds: [question.questionId],
});
store.reviewLesson({
  projectId,
  lessonId: lesson.lessonId,
  version: 1,
  decision: 'approved',
  note: '自动链路样本',
});
store.publishLesson({ projectId, lessonId: lesson.lessonId, version: 1 });
const stageId = 'stage_link_fixture';
const document = {
  stage: { id: stageId },
  dslVersion: '0.11.2',
  scenes: [1, 2].map((order) => ({
    id: `scene-${order}`,
    type: 'slide',
    title: order === 1 ? '定义' : '例题',
    order: order - 1,
    content: {
      type: 'slide',
      schemaVersion: 1,
      canvas: {
        elements: [
          {
            id: `element-${order}`,
            type: 'text',
            left: 0,
            top: 0,
            width: 320,
            height: 80,
            rotate: 0,
            content: order === 1 ? '<p>函数值随自变量增大</p>' : '<p>例题讨论</p>',
          },
        ],
      },
    },
  })),
};
const documentDigest = domain.classroomDocumentDigest(document);
store.saveClassroomDocument({
  projectId,
  lessonId: lesson.lessonId,
  stageId,
  dslVersion: document.dslVersion,
  document,
  digest: documentDigest,
  sceneCount: document.scenes.length,
  scenes: document.scenes.map((scene) => ({
    sceneId: scene.id,
    knowledgeIds: [knowledge.knowledgeId],
    questionId: null,
  })),
  reviewedBy: 'local_fixture',
  reviewNote: '自动链路样本',
  recordScope: 'formal',
});
store.attachLessonDocument({
  projectId,
  lessonId: lesson.lessonId,
  version: 1,
  stageId,
  documentDigest,
});

const { GET, POST } = await import('../apps/learning/app/api/study/collab/online/route.ts');
const server = http.createServer(async (incoming, outgoing) => {
  const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
  if (
    !['GET', 'POST'].includes(incoming.method ?? '') ||
    url.pathname !== '/api/study/collab/online'
  ) {
    outgoing.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const headers = new Headers({
      'x-sew-project-id': session.projectId,
      'x-sew-generation': String(session.generation),
      ...(incoming.method === 'POST' ? { 'content-type': 'application/json' } : {}),
    });
    const request = new Request(`http://127.0.0.1${url.pathname}${url.search}`, {
      method: incoming.method,
      headers,
      body: incoming.method === 'POST' ? Buffer.concat(chunks) : undefined,
    });
    const response = await (incoming.method === 'GET' ? GET(request) : POST(request));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500, { 'content-type': 'application/json' });
    outgoing.end(
      JSON.stringify({
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      }),
    );
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(
    `${JSON.stringify({
      type: 'ready',
      origin: `http://127.0.0.1:${address.port}`,
      uid,
      projectId: session.projectId,
      generation: session.generation,
      lessonId: lesson.lessonId,
      lessonVersion: 1,
      snapshotDigest: documentDigest,
      scenes: document.scenes.map((scene) => ({ sceneId: scene.id, type: scene.type })),
      protocolVersion: contracts.COLLAB_PROTOCOL_VERSION,
    })}\n`,
  );
});

const shutdown = () =>
  server.close(() => {
    session.store.close();
    process.exit(0);
  });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
