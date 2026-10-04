/** Actual route Responses + temporary SQLite, passed through the renderer client.
 * In-process integration coverage, not installed-desktop or real-subject acceptance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiResponses, newId } from '@sew/study-contracts';
import { apiFetch } from '../apps/learning/lib/client';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';
import { POST as materialPost } from '../apps/learning/app/api/study/materials/route';
import { POST as proposalPost } from '../apps/learning/app/api/study/knowledge/propose/route';
import { POST as reviewPost } from '../apps/learning/app/api/study/knowledge/review/route';
import { POST as syllabusPost } from '../apps/learning/app/api/study/syllabus/route';
import { POST as admissionPost } from '../apps/learning/app/api/study/admission/route';
import { POST as planPost } from '../apps/learning/app/api/study/plan/route';
import { POST as runPost } from '../apps/learning/app/api/study/run/route';
import { POST as lessonPost } from '../apps/learning/app/api/study/lessons/route';
import { POST as rolePost } from '../apps/learning/app/api/study/roles/route';
import { GET as assetGet, POST as assetPost } from '../apps/learning/app/api/study/assets/route';
import { PATCH as projectPatch } from '../apps/learning/app/api/study/project/route';
import { PUT as preferencesPut } from '../apps/learning/app/api/study/preferences/route';
import { GET as rawGet } from '../apps/learning/app/api/study/materials/[materialId]/raw/route';
import { POST as examPost } from '../apps/learning/app/api/study/materials/[materialId]/exam-verification/route';
import { DEFAULT_PREFERENCES, DEFAULT_TEACHING_PREFERENCE } from '../apps/learning/lib/preferences';

const routes: Record<string, (request: Request) => Promise<Response>> = {
  '/api/study/materials': materialPost, '/api/study/knowledge/propose': proposalPost,
  '/api/study/knowledge/review': reviewPost, '/api/study/syllabus': syllabusPost,
  '/api/study/admission': admissionPost, '/api/study/plan': planPost,
  '/api/study/run': runPost, '/api/study/lessons': lessonPost, '/api/study/roles': rolePost,
  '/api/study/assets': assetPost,
  '/api/study/project': projectPatch, '/api/study/preferences': preferencesPut,
};

describe('M1 renderer response integration', () => {
  let root: string;
  let session: Session;
  const init = (body: Record<string, unknown>): RequestInit => ({
    method: 'POST', body: JSON.stringify({ scope: { projectId: session.projectId, generation: session.generation }, ...body }),
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-response-flow-'));
    vi.stubEnv('SEW_USER_DATA_DIR', join(root, 'test-profile'));
    session = openProjectFromDisk(root);
    vi.stubGlobal('fetch', async (path: string, options?: RequestInit) => {
      if (path === '/api/study/assets' && !options?.method) return assetGet();
      const materialMatch = path.match(/^\/api\/study\/materials\/([^/]+)\/(raw|exam-verification)(?:\?.*)?$/);
      if (materialMatch) {
        const request = new Request(`http://service.local${path}`, options);
        const context = { params: Promise.resolve({ materialId: materialMatch[1]! }) };
        return materialMatch[2] === 'raw' ? rawGet(request, context) : examPost(request);
      }
      const handler = routes[path];
      if (!handler) throw new Error(`Unmapped route: ${path}`);
      return handler(new Request(`http://service.local${path}`, options));
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); closeProject(); rmSync(root, { recursive: true, force: true });
  });

  it('imports, reviews, confirms tasks, starts a run and freezes/drafts/publishes without contract drift', async () => {
    const imported = await apiFetch('/api/study/materials', apiResponses.materialImport, init({
      mode: 'text', displayName: '回归测试考纲.md', type: 'md', readableLocation: '第一章',
      rawText: '理解增函数定义：任取 x1 < x2，有 f(x1) < f(x2)。',
    }));
    const source = { materialId: imported.material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' };
    const syllabus = await apiFetch('/api/study/syllabus', apiResponses.syllabusCreate, init({
      code: '1.1', label: '增函数定义', requirements: [{ key: 'definition', text: '定义' }], source,
    }));
    const { proposal } = await apiFetch('/api/study/knowledge/propose', apiResponses.proposal, init({
      name: '增函数', concept: '任取 x1 < x2，有 f(x1) < f(x2)', conditions: '同一区间内',
      scopeStatus: 'in_syllabus', prerequisites: [], evidence: [source], acceptance: '能独立解释定义', priority: 'medium', proposedBy: 'user',
    }));
    const review = await apiFetch('/api/study/knowledge/review', apiResponses.review, init({
      proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true,
      note: '仅用于自动回归，不代表真实考试考纲审核', syllabus: { itemId: syllabus.item.itemId, requirementKey: 'definition' },
    }));
    const knowledgeId = review.knowledgePoint!.knowledgeId;
    expect((await apiFetch('/api/study/admission', apiResponses.admission, init({ knowledgeIds: [knowledgeId] }))).allowed).toBe(true);
    const draftPlan = await apiFetch('/api/study/plan', apiResponses.planWrite, init({ action: 'generate' }));
    expect(draftPlan.status).toBe('draft');
    await apiFetch('/api/study/plan', apiResponses.planWrite, init({ action: 'confirm-task', knowledgeId, decision: 'accept' }));
    const confirmed = await apiFetch('/api/study/plan', apiResponses.planWrite, init({ action: 'confirm' }));
    expect(confirmed.plan.confirmedTaskKnowledgeIds).toEqual([knowledgeId]);
    const run = await apiFetch('/api/study/run', apiResponses.runStart, init({ action: 'start' }));
    expect(run.snapshot.frozen.planVersion).toBe(confirmed.version);
    expect((await apiFetch('/api/study/run', apiResponses.runStart, init({ action: 'start' }))).deduplicated).toBe(true);
    const bundle = await apiFetch('/api/study/lessons', apiResponses.lessonBundle, init({
      action: 'build-bundle', statements: [{ knowledgeId, text: proposal.concept, conditions: proposal.conditions }], questionIds: [],
    }));
    const lesson = await apiFetch('/api/study/lessons', apiResponses.lessonDraft, init({
      action: 'draft', lessonId: null, bundleId: bundle.bundleId, title: '回归测试课程', statementIds: bundle.bundle.statements.map(row => row.statementId), questionIds: [],
    }));
    expect(lesson.lesson).not.toHaveProperty('projectId');
    // 未审核的草案不能发布：服务端给出「需先审核」而不是静默成功。
    await expect(apiFetch('/api/study/lessons', apiResponses.lessonPublish, init({
      action: 'publish', lessonId: lesson.lesson.lessonId, version: lesson.lesson.version,
    }))).rejects.toThrow(/该课堂文档不是已登记的审核课件/);
    const reviewed = await apiFetch('/api/study/lessons', apiResponses.lessonReview, init({
      action: 'review', lessonId: lesson.lesson.lessonId, version: lesson.lesson.version, decision: 'approved', note: '按原文核对',
    }));
    expect(reviewed.review.admittedKnowledgeIds).toEqual([knowledgeId]);
    const published = await apiFetch('/api/study/lessons', apiResponses.lessonPublish, init({
      action: 'publish', lessonId: lesson.lesson.lessonId, version: lesson.lesson.version,
    }));
    expect(published.lesson.status).toBe('published');
    expect(published.link.evidenceBundleId).toBe(bundle.bundleId);
    const withdrawn = await apiFetch('/api/study/lessons', apiResponses.lessonWithdraw, init({
      action: 'withdraw', lessonId: lesson.lesson.lessonId, reason: '回归测试撤回',
    }));
    expect(withdrawn.lesson.status).toBe('withdrawn');
    expect(withdrawn.link.statusNote).toBe('回归测试撤回');
  });

  it('role CRUD and asset reclaim deliver validated real responses', async () => {
    const created = await apiFetch('/api/study/roles', apiResponses.roleWrite, init({
      action: 'create', kind: 'teacher', name: '教师', persona: '', explanation: 'concise',
    }));
    const profileId = created.profile!.profileId;
    const updated = await apiFetch('/api/study/roles', apiResponses.roleWrite, init({
      action: 'update', profileId, name: '修改教师', persona: '先提示', explanation: 'rigorous',
    }));
    expect(updated.profile?.configVersion).toBe(2);
    expect((await apiFetch('/api/study/roles', apiResponses.roleWrite, init({ action: 'delete', profileId }))).profile).toBeNull();
    session.store.putClassroomAsset(session.projectId, 'asset-test', 'image/png', {}, Uint8Array.from([1, 2, 3]));
    expect((await apiFetch('/api/study/assets', apiResponses.assetReport)).unboundBytes).toBe(3);
    expect((await apiFetch('/api/study/assets', apiResponses.assetReclaim, init({ assetIds: ['asset-test'] }))).freedBytes).toBe(3);
  });

  it('a missing course returns a validated NOT_FOUND failure instead of success', async () => {
    await expect(apiFetch('/api/study/lessons', apiResponses.lessonDraft, init({
      action: 'draft', lessonId: newId<'lesson'>('lesson'), bundleId: 'bundle-absent', title: '不存在的课程', statementIds: ['statement-absent'], questionIds: [],
    }))).rejects.toMatchObject({ code: 'NOT_FOUND', pending: false });
  });

  it('validates settings, original archive and exam provenance responses', async () => {
    const project = await apiFetch('/api/study/project', apiResponses.project, { ...init({ subject: '数学' }), method: 'PATCH' });
    expect(project.project.subject).toBe('数学');
    const appearance = await apiFetch('/api/study/preferences', apiResponses.appearanceWrite, {
      ...init({ appearance: { ...DEFAULT_PREFERENCES, theme: 'dark' } }), method: 'PUT',
    });
    expect(appearance.appearance.theme).toBe('dark');
    const teaching = await apiFetch('/api/study/preferences', apiResponses.teachingWrite, {
      ...init({ teaching: DEFAULT_TEACHING_PREFERENCE }), method: 'PUT',
    });
    expect(teaching.teaching.explanation).toBe('intuitive');
    const sourcePath = join(root, '原文.md');
    writeFileSync(sourcePath, '回归原文\r\n\r\n完整保留换行', 'utf8');
    const imported = await apiFetch('/api/study/materials', apiResponses.materialImport, init({
      mode: 'file', sourcePath, displayName: '原文.md', type: 'md', readableLocation: '回归测试',
    }));
    const materialId = imported.material.materialId;
    const raw = await apiFetch(`/api/study/materials/${materialId}/raw?revision=1&segmentId=S001`, apiResponses.materialRaw);
    expect(raw.rawText).toContain('\r\n');
    const verified = await apiFetch(`/api/study/materials/${materialId}/exam-verification`, apiResponses.examVerification, init({
      materialId, revision: 1, note: '自动回归专用，不代表真实考试来源核验', confirmed: true,
    }));
    expect(verified.materialId).toBe(materialId);
  });
});
