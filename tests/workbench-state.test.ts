import { describe, expect, it, vi } from 'vitest';
import { buildWorkbenchState } from '../apps/learning/lib/server/state';
import type { Session } from '../apps/learning/lib/server/service';

describe('buildWorkbenchState admission summary', () => {
  it('checks the knowledge list in one batch and preserves mixed eligibility counts', () => {
    const knowledge = [
      { knowledgeId: 'k-ready', sourceStatus: 'verified' },
      { knowledgeId: 'k-blocked', sourceStatus: 'pending' },
    ];
    const store = {
      getProject: vi.fn(() => ({
        projectId: 'project-1',
        displayName: '测试项目',
        subject: '',
        goal: '',
        examDate: null,
        dailyMinutes: 0,
        learningMode: 'beginner',
        formatVersion: 1,
        createdAt: '',
        updatedAt: '',
      })),
      listKnowledge: vi.fn(() => knowledge),
      listProposals: vi.fn(() => []),
      listMaterials: vi.fn(() => []),
      countAttemptKinds: vi.fn(() => ({ real: 0, simulation: 0 })),
      getConfirmedPlan: vi.fn(() => null),
      listQuestions: vi.fn(() => []),
      checkAdmission: vi.fn(() => ({
        allowed: false,
        admitted: ['k-ready'],
        blocked: [{
          knowledgeId: 'k-blocked',
          code: 'KNOWLEDGE_NOT_VERIFIED',
          message: '待核实',
          missing: [],
        }],
      })),
    };
    const session = {
      projectId: 'project-1',
      displayName: '测试项目',
      displayPath: '/tmp/project-1',
      generation: 1,
      store,
      openedAt: new Date(0).toISOString(),
    } as unknown as Session;

    const state = buildWorkbenchState(session);

    expect(store.checkAdmission).toHaveBeenCalledTimes(1);
    expect(store.checkAdmission).toHaveBeenCalledWith(['k-ready', 'k-blocked']);
    expect(state.admission).toEqual({ readyKnowledge: 1, blockedBySource: 1 });
  });
});
