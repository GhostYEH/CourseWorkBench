import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProject, openProjectFromDisk, type Session } from '../apps/learning/lib/server/service';
import { GET as getCandidates } from '../apps/learning/app/api/study/knowledge/candidates/route';
import { GET as getState } from '../apps/learning/app/api/study/state/route';
import { PATCH as patchProject } from '../apps/learning/app/api/study/project/route';

describe('workbench reads after mutations', () => {
  let directory: string;
  let session: Session;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'sew-workbench-read-'));
    session = openProjectFromDisk(directory);
  });
  afterEach(() => {
    closeProject();
    const holder = (globalThis as { __sewSession?: { environmentBootstrapSuppressed?: boolean } }).__sewSession;
    if (holder) holder.environmentBootstrapSuppressed = false;
    rmSync(directory, { recursive: true, force: true });
  });

  it('project PATCH returns newly written settings and the next state request sees them', async () => {
    const before = await getState();
    expect((await before.json()).data.project.goal).toBe('');
    const response = await patchProject(new Request('http://service.local/api/study/project', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { projectId: session.projectId, generation: session.generation }, goal: '新的学习目标' }),
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.project.goal).toBe('新的学习目标');
    const after = await getState();
    expect((await after.json()).data.project.goal).toBe('新的学习目标');
  });

  it('state preserves current material version counts and immediately reflects invalidated knowledge', async () => {
    const input = { projectId: session.projectId, displayName: '函数.md', materialType: 'md' as const, rawText: '函数在区间内单调递增。' };
    const { material, segments } = session.store.importMaterial(input);
    const proposal = session.store.createProposal({
      projectId: session.projectId, name: '递增', concept: '函数单调递增', conditions: '', scopeStatus: 'in_syllabus',
      prerequisites: [], evidence: [{ materialId: material.materialId, revision: 1, segmentId: segments[0]!.segmentId, use: 'concept_basis' }],
      acceptance: '', priority: 'medium', proposedBy: 'user',
    });
    session.store.applyReview({ proposalId: proposal.proposalId, decision: 'approved', expectedRevision: proposal.revision, semanticReviewed: true });
    const before = (await (await getState()).json()).data;
    expect(before.counts.materials).toBe(1);
    expect(before.counts.knowledgeVerified).toBeGreaterThan(0);
    expect(before.admission.blockedBySource).toBe(0);
    session.store.importMaterial({ ...input, rawText: `${input.rawText}\n\n已更新。` });
    const after = (await (await getState()).json()).data;
    expect(after.counts.materials).toBe(1);
    expect(after.counts.knowledgeInvalidated).toBe(before.counts.knowledgeVerified);
    expect(after.admission.blockedBySource).toBeGreaterThan(0);
  });

  it('candidate filtering preserves order and pending totals across reviews', async () => {
    const create = (name: string) => session.store.createProposal({
      projectId: session.projectId, name, concept: name, conditions: '', scopeStatus: 'in_syllabus',
      prerequisites: [], evidence: [], acceptance: '', priority: 'medium', proposedBy: 'user',
    });
    const pending = create('待审核');
    const needsMaterial = create('需要补材料');
    const rejected = create('已拒绝');
    session.store.applyReview({ proposalId: needsMaterial.proposalId, decision: 'needs_material', expectedRevision: 0, semanticReviewed: false });
    session.store.applyReview({ proposalId: rejected.proposalId, decision: 'rejected', expectedRevision: 0, semanticReviewed: false });
    for (const status of [undefined, 'pending', 'needs_material', 'rejected']) {
      const response = await getCandidates(new Request(`http://service.local/api/study/knowledge/candidates${status ? `?status=${status}` : ''}`));
      expect(response.status).toBe(200);
      const data = (await response.json()).data;
      expect(data.pendingCount).toBe(2);
      expect(data.proposals.map((proposal: { proposalId: string }) => proposal.proposalId))
        .toEqual(session.store.listProposals(status as 'pending' | 'needs_material' | 'rejected' | undefined).map(proposal => proposal.proposalId));
    }
    session.store.applyReview({ proposalId: pending.proposalId, decision: 'rejected', expectedRevision: 0, semanticReviewed: false });
    const after = await getCandidates(new Request('http://service.local/api/study/knowledge/candidates'));
    expect((await after.json()).data.pendingCount).toBe(1);
  });
});
