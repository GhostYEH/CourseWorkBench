import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { ClassroomSharedCourseDto, CollabTeachingAiReadViewDto } from '@sew/study-contracts';
import { CollabTeachingAiPanel } from '../apps/learning/components/collab-teaching-ai-panel';

const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
const { createElement } = require('react') as {
  createElement: (type: unknown, props: unknown) => unknown;
};
const selfUid = 'uid_00000000-0000-4000-8000-000000000001';
const snapshot: ClassroomSharedCourseDto = {
  snapshotVersion: 1,
  course: {
    lessonId: 'lesson',
    lessonVersion: 1,
    title: '共同课程',
    stageId: 'stage',
    dslVersion: '0.11.2',
    documentDigest: 'a'.repeat(64),
    bundleDigest: 'b'.repeat(64),
  },
  scenes: [{ sceneId: 'scene', type: 'slide', title: '场景', order: 0, elements: [] }],
  evidence: {
    planVersion: 1,
    knowledgeVersions: [{ knowledgeId: 'knowledge', revision: 1 }],
    statements: [
      {
        statementId: 'statement',
        knowledgeId: 'knowledge',
        text: '已审核依据陈述正文',
        conditions: '条件成立时',
        evidence: [
          { materialId: 'material', revision: 1, segmentId: 'segment', use: 'concept_basis' },
        ],
      },
    ],
    segments: [
      {
        materialId: 'material',
        revision: 1,
        segmentId: 'segment',
        fingerprint: 'c'.repeat(64),
        text: '来源原文',
      },
    ],
  },
  sceneSources: [{ sceneId: 'scene', knowledgeIds: ['knowledge'], questionId: null }],
  assets: [],
};

const view = (facts: {
  owner: boolean;
  status?: 'pending' | 'approved' | 'rejected';
  gateReason?:
    | 'not_room_member'
    | 'collab_room_not_active'
    | 'collab_ai_owner_required'
    | 'collab_ai_waiting_learner'
    | 'collab_ai_candidate_limit'
    | 'collab_ai_output_limit'
    | null;
  publicOutput?: boolean;
}): CollabTeachingAiReadViewDto => ({
  roomId: 'room',
  sceneId: 'scene',
  state: facts.owner
    ? {
        schemaVersion: 1,
        roomId: 'room',
        sceneId: 'scene',
        candidates: [
          {
            candidateId: 'candidate',
            seq: 1,
            sceneId: 'scene',
            anchorStatementId: 'statement',
            senderType: 'peer_ai',
            roleProfileId: 'peer-role',
            peerName: '好奇同学',
            body: '仅待审核候选正文',
            model: 'model-a',
            origin: 'model_generated',
            status: facts.status ?? 'pending',
            reviewNote: '仅房主可见备注',
            reviewedByUid: null,
            createdAt: '2026-10-07T00:00:00.000Z',
            updatedAt: '2026-10-07T00:00:00.000Z',
          },
        ],
        publicOutputs: [],
      }
    : null,
  publicOutputs: facts.publicOutput
    ? [
        {
          seq: 2,
          eventId: 'public-event',
          senderType: 'peer_ai',
          aiLabel: 'AI',
          displayName: '好奇同学',
          body: '已经审核并公开的内容',
          anchorStatementId: 'statement',
          conditions: '条件成立时',
        },
      ]
    : [],
  roomRevision: 1,
  tailSeq: 1,
  gate: {
    canGenerate: facts.gateReason === null || facts.gateReason === undefined,
    reason: facts.gateReason ?? null,
  },
});

const render = (
  readView: CollabTeachingAiReadViewDto,
  self: string | null = selfUid,
  options: { enabled?: boolean; busy?: boolean } = {},
): string =>
  renderToStaticMarkup(
    createElement(CollabTeachingAiPanel, {
      view: readView,
      snapshot,
      selfUid: self,
      enabled: options.enabled ?? true,
      busy: options.busy ?? false,
      peerProfiles: [{ roleProfileId: 'peer-role', name: '好奇同学' }],
      onOperation: () => undefined,
    }),
  );

describe('生成式教师与 AI 同学面板', () => {
  it('普通成员只读公共投影，看到 AI 标记、锚点来源和条件，不泄露候选', () => {
    const markup = render(view({ owner: false, publicOutput: true }), null);
    const publicSection = markup.slice(
      markup.indexOf('data-collab-teaching-ai-public'),
      markup.indexOf('</section>') + '</section>'.length,
    );

    expect(publicSection).toContain('AI · 好奇同学');
    expect(publicSection).toContain('已经审核并公开的内容');
    expect(publicSection).toContain('来源陈述 statement · 已审核依据陈述正文');
    expect(publicSection).toContain('适用条件：条件成立时');
    expect(publicSection).not.toContain('仅待审核候选正文');
    expect(markup).not.toContain('data-collab-teaching-ai-owner');
  });

  it('候选先留在房主待核区，未勾语义审核前不能批准/拒绝，也不能广播', () => {
    const markup = render(view({ owner: true, gateReason: null }));
    const publicSection = markup.slice(
      markup.indexOf('data-collab-teaching-ai-public'),
      markup.indexOf('data-collab-teaching-ai-owner'),
    );

    expect(publicSection).not.toContain('仅待审核候选正文');
    expect(markup).toContain('data-collab-teaching-ai-candidate="candidate"');
    expect(markup).toContain('好奇同学');
    expect(markup).toContain('data-collab-teaching-ai-semantic-reviewed="candidate"');
    expect(markup).toMatch(/data-collab-teaching-ai-approve="candidate" disabled=""/);
    expect(markup).toMatch(/data-collab-teaching-ai-reject="candidate" disabled=""/);
    expect(markup).not.toContain('data-collab-teaching-ai-broadcast');
  });

  it('等待或非活动房间门禁会禁用生成、审核和已经批准候选的播报', () => {
    const waiting = render(view({ owner: true, gateReason: 'collab_ai_waiting_learner' }));
    const inactive = render(
      view({ owner: true, status: 'approved', gateReason: 'collab_room_not_active' }),
    );

    expect(waiting).toMatch(/data-collab-teaching-ai-generate-teacher="true" disabled=""/);
    expect(waiting).toMatch(/data-collab-teaching-ai-approve="candidate" disabled=""/);
    expect(inactive).toContain('data-collab-teaching-ai-broadcast="candidate" disabled=""');
  });

  it('操作请求忙碌或应用门禁关闭时不开放新的模型与审核命令', () => {
    const busy = render(view({ owner: true, gateReason: null }), selfUid, { busy: true });
    const disabled = render(view({ owner: true, gateReason: null }), selfUid, { enabled: false });

    expect(busy).toContain('data-collab-teaching-ai-generate-teacher="true" disabled=""');
    expect(busy).toContain('data-collab-teaching-ai-approve="candidate" disabled=""');
    expect(disabled).toContain('data-collab-teaching-ai-generate-peer="true" disabled=""');
    expect(disabled).toContain('data-collab-teaching-ai-reject="candidate" disabled=""');
  });

  it('已批准候选仍需显式播报，且尚未出现在公共投影中', () => {
    const markup = render(view({ owner: true, status: 'approved', gateReason: null }));
    const publicSection = markup.slice(
      markup.indexOf('data-collab-teaching-ai-public'),
      markup.indexOf('data-collab-teaching-ai-owner'),
    );

    expect(publicSection).not.toContain('仅待审核候选正文');
    expect(markup).toContain('data-collab-teaching-ai-broadcast="candidate"');
    expect(markup).toContain('播报到 AI 公共讨论');
  });
});
