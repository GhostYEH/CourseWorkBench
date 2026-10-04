import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StudyError,
  newId,
  roleCreateSchema,
  type PlanPayloadDto,
} from '@sew/study-contracts';
import { StudyStore, createNodeSqliteDriver, ensureProjectLayout, projectPaths } from '@sew/study-storage';

/**
 * 计划确认、run 启动、角色档案与版本化 JSON 读取（PLAN-01 / STYLE-01 / N8）。
 *
 * 关注点不是字段多少，而是三类不可信 JSON 都不能「解析后直接断言」：
 * 计划载荷、运行冻结快照与步骤收据损坏或形状不符时必须可诊断拒绝，
 * 恢复路径不得消费损坏收据。
 */

const expectCode = (action: () => unknown, code: string, reason?: string): void => {
  try {
    action();
  } catch (error) {
    expect((error as StudyError).code).toBe(code);
    if (reason !== undefined) expect((error as StudyError).details?.['reason']).toBe(reason);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
};

describe('计划、run 与角色档案', () => {
  let root: string;
  let store: StudyStore;
  let projectId: string;

  const addKnowledge = (name: string): string => {
    const { material } = store.importMaterial({
      projectId,
      displayName: `${name}.md`,
      materialType: 'md',
      rawText: `${name}的定义。\n\n${name}的适用条件。`,
    });
    const proposal = store.createProposal({
      projectId,
      name,
      concept: `${name} 的概念陈述`,
      conditions: '',
      scopeStatus: 'in_syllabus',
      prerequisites: [],
      evidence: [{ materialId: material.materialId, revision: 1, segmentId: 'S001', use: 'concept_basis' }],
      acceptance: '',
      priority: 'medium',
      proposedBy: 'user',
    });
    return store.applyReview({
      proposalId: proposal.proposalId,
      decision: 'approved',
      expectedRevision: proposal.revision,
      semanticReviewed: true,
    }).knowledgePoint!.knowledgeId;
  };

  /** 走 HTTP 同一条生成逻辑的最小替身：直接按存储层合同写入草案。 */
  const buildDraft = (): PlanPayloadDto => {
    const latest = store.getLatestPlan(projectId);
    const version = (latest?.version ?? 0) + 1;
    const points = store.listKnowledge('formal');
    const payload: PlanPayloadDto = {
      payloadVersion: 1,
      goal: '掌握本章',
      examDate: null,
      dailyMinutes: 60,
      tasks: points.map((point) => ({
        knowledgeId: point.knowledgeId,
        name: point.name,
        minutes: 30,
        acceptance: point.acceptance,
        evidence: point.evidence.map((item) => ({ materialId: item.materialId, segmentId: item.segmentId })),
      })),
      gaps: [],
      basis: '测试草案',
      confirmedTaskKnowledgeIds: [],
    };
    store.savePlanVersion(projectId, version, 'draft', payload);
    return payload;
  };

  const confirmPlanWith = (acceptedKnowledgeIds: string[]): number => {
    const draft = store.getLatestPlan(projectId)!;
    const payload: PlanPayloadDto = {
      ...draft.payload,
      tasks: draft.payload.tasks.filter((task) => acceptedKnowledgeIds.includes(task.knowledgeId)),
      gaps: [
        ...draft.payload.gaps,
        ...draft.payload.tasks
          .filter((task) => !acceptedKnowledgeIds.includes(task.knowledgeId))
          .map((task) => ({
            knowledgeId: task.knowledgeId,
            name: task.name,
            code: 'TASK_NOT_CONFIRMED',
            missing: ['该任务未逐条确认，暂不进入正式 run'],
          })),
      ],
      confirmedTaskKnowledgeIds: acceptedKnowledgeIds,
    };
    store.savePlanVersion(projectId, draft.version, 'confirmed', payload);
    return draft.version;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-plan-run-'));
    ensureProjectLayout(root);
    store = StudyStore.open({ file: projectPaths(root).databaseFile });
    projectId = newId<'project'>('proj');
    store.createProject({ projectId, displayName: '数学', subject: '数学', dailyMinutes: 60 });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 已关闭 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  describe('计划载荷版本化（N8）', () => {
    it('缺少版本号或带未知字段的载荷在写入时就被拒绝', () => {
      const draft = buildDraft();
      expectCode(
        () => store.savePlanVersion(projectId, 9, 'draft', { ...draft, payloadVersion: 2 as 1 }),
        'INTERNAL',
        'invalid_plan_payload',
      );
      expectCode(
        () => store.savePlanVersion(projectId, 9, 'draft', { ...draft, extra: 'x' } as unknown as PlanPayloadDto),
        'INTERNAL',
        'invalid_plan_payload',
      );
      expect(store.getLatestPlan(projectId)?.version).not.toBe(9);
    });

    it('损坏的历史载荷按权威列拒绝，不降级成「没有计划」', () => {
      buildDraft();
      store.close();
      const db = createNodeSqliteDriver().open(join(root, '.study', 'study.db'));
      db.prepare("UPDATE plan_versions SET payload_json = '{\"goal\":\"只有半个载荷\"}' WHERE project_id = ?").run(projectId);
      db.close();

      store = StudyStore.open({ file: projectPaths(root).databaseFile });
      expectCode(() => store.getLatestPlan(projectId), 'INTERNAL');
    });

    it('v11 迁移为符合旧形状的历史载荷补标版本号与确认清单', () => {
      const legacy = JSON.stringify({
        goal: '旧版计划',
        examDate: null,
        dailyMinutes: 60,
        tasks: [{ knowledgeId: 'kp-old', name: '旧任务', minutes: 30, acceptance: '', evidence: [] }],
        gaps: [],
        basis: '旧版依据',
      });
      store.close();
      const db = createNodeSqliteDriver().open(join(root, '.study', 'study.db'));
      db.prepare("DELETE FROM schema_migrations WHERE version = 11").run();
      db.prepare('INSERT INTO plan_versions (project_id, version, status, payload_json, created_at) VALUES (?, 1, ?, ?, ?)')
        .run(projectId, 'draft', legacy, new Date().toISOString());
      db.close();

      store = StudyStore.open({ file: projectPaths(root).databaseFile });
      const migrated = store.getLatestPlan(projectId);
      expect(migrated?.payload.payloadVersion).toBe(1);
      expect(migrated?.payload.confirmedTaskKnowledgeIds).toEqual([]);
    });
  });

  describe('计划逐条确认与 run 启动（PLAN-01）', () => {
    it('没有已确认计划或没有逐条确认任务时不能启动 run', () => {
      buildDraft();
      expectCode(() => store.startPlanRun(projectId), 'PLAN_NOT_CONFIRMED');
      expect(store.getLatestRun()).toBeNull();

      // 已确认版本里确认清单为空（旧数据形态）同样不能启动，不能靠「有计划」放行。
      const version = confirmPlanWith([]);
      expect(store.getConfirmedPlan(projectId)?.version).toBe(version);
      expectCode(() => store.startPlanRun(projectId), 'PLAN_NOT_CONFIRMED', 'no_confirmed_tasks');
      expect(store.getLatestRun()).toBeNull();
    });

    it('未确认的任务转入待核范围，run 只按已确认版本启动且重复启动读回同一 run', () => {
      const first = addKnowledge('单调性');
      const second = addKnowledge('奇偶性');
      buildDraft();
      const version = confirmPlanWith([first]);

      const confirmed = store.getConfirmedPlan(projectId);
      expect(confirmed?.version).toBe(version);
      expect(confirmed?.payload.tasks.map((task) => task.knowledgeId)).toEqual([first]);
      expect(confirmed?.payload.gaps.some((gap) => gap.knowledgeId === second && gap.code === 'TASK_NOT_CONFIRMED')).toBe(true);

      const started = store.startPlanRun(projectId);
      expect(started.deduplicated).toBe(false);
      expect(started.run.frozen.planVersion).toBe(version);
      expect(started.run.frozen.knowledgeTableDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(started.run.frozen.modelProfileId).toBeNull();

      const again = store.startPlanRun(projectId);
      expect(again.deduplicated).toBe(true);
      expect(again.run.runId).toBe(started.run.runId);
      expect(store.listRunEvents(started.run.runId)).toHaveLength(1);
      expect(store.getLatestRun()?.runId).toBe(started.run.runId);
    });

    it('冻结快照记录知识点摘要与材料版本，清单变化后新计划得到新摘要', () => {
      const firstId = addKnowledge('定义');
      buildDraft();
      confirmPlanWith([firstId]);
      const before = store.startPlanRun(projectId).run.frozen;
      expect(before.planVersion).toBe(1);

      addKnowledge('另一个知识点');
      buildDraft();
      // 草案本身不会改变 run：必须确认新版本才产生新的冻结快照。
      const stillOld = store.startPlanRun(projectId);
      expect(stillOld.deduplicated).toBe(true);
      expect(stillOld.run.frozen.knowledgeTableDigest).toBe(before.knowledgeTableDigest);

      confirmPlanWith([firstId]);
      const after = store.startPlanRun(projectId).run.frozen;
      expect(after.planVersion).toBe(2);
      expect(after.knowledgeTableDigest).not.toBe(before.knowledgeTableDigest);
    });

    it('收据与事件载荷损坏时拒绝读取，恢复不消费损坏收据', () => {
      addKnowledge('定义');
      buildDraft();
      confirmPlanWith([store.listKnowledge('formal')[0]!.knowledgeId]);
      const runId = store.startPlanRun(projectId).run.runId;
      store.close();

      const db = createNodeSqliteDriver().open(join(root, '.study', 'study.db'));
      db.prepare("UPDATE step_receipts SET result_json = '{\"receiptVersion\":9}'").run();
      db.prepare("UPDATE run_events SET payload_json = '{\"type\":\"run_started\"}'").run();
      db.close();

      store = StudyStore.open({ file: projectPaths(root).databaseFile });
      const stepKey = ['run-start', projectId, `v${store.getLatestRun()?.frozen.planVersion}`].join('|');
      expectCode(() => store.getStepReceipt(stepKey), 'INTERNAL');
      expectCode(() => store.listRunEvents(runId), 'INTERNAL');
    });
  });

  describe('角色档案与权限派生（STYLE-01）', () => {
    it('教师档案唯一、同学最多两名，删除名额后可以再添加', () => {
      const teacher = store.createRoleProfile('teacher', { name: '教师', persona: '', explanation: 'intuitive' });
      expectCode(
        () => store.createRoleProfile('teacher', { name: '另一位', persona: '', explanation: 'concise' }),
        'ROLE_TEACHER_EXISTS',
      );
      store.createRoleProfile('peer', { name: '甲', persona: '', explanation: 'concise' });
      store.createRoleProfile('peer', { name: '乙', persona: '', explanation: 'rigorous' });
      expectCode(
        () => store.createRoleProfile('peer', { name: '丙', persona: '', explanation: 'concise' }),
        'ROLE_LIMIT_REACHED',
      );
      const peers = store.listRoleProfiles().filter((profile) => profile.kind === 'peer');
      store.deleteRoleProfile(peers[0]!.profileId);
      expect(store.createRoleProfile('peer', { name: '丙', persona: '', explanation: 'concise' }).kind).toBe('peer');
      expect(teacher.kind).toBe('teacher');
    });

    it('权限按类型派生且合同不接受客户端自报权限', () => {
      const teacher = store.createRoleProfile('teacher', { name: '教师', persona: '', explanation: 'intuitive' });
      const peer = store.createRoleProfile('peer', { name: '同学', persona: '', explanation: 'concise' });
      expect(teacher.permissions).toEqual({
        whiteboardWrite: true, answerAsLearner: false, speak: true, aiIdentityVisible: true,
      });
      expect(peer.permissions.whiteboardWrite).toBe(false);
      expect(peer.permissions.answerAsLearner).toBe(false);

      expect(
        roleCreateSchema.safeParse({
          scope: { projectId, generation: 1 },
          kind: 'peer',
          name: '同学',
          persona: '',
          explanation: 'concise',
          permissions: { whiteboardWrite: true },
        }).success,
      ).toBe(false);
    });

    it('修改档案递增版本号并改变配置摘要；未配置时摘要为 null', () => {
      expect(store.roleConfigDigest()).toBeNull();
      const peer = store.createRoleProfile('peer', { name: '同学', persona: '', explanation: 'concise' });
      const digest = store.roleConfigDigest();
      expect(digest).toMatch(/^[0-9a-f]{64}$/);

      const updated = store.updateRoleProfile(peer.profileId, { name: '同学', persona: '', explanation: 'rigorous' });
      expect(updated.configVersion).toBe(2);
      expect(store.roleConfigDigest()).not.toBe(digest);

      // 内容未变的重复保存不产生新版本，避免无意义的摘要漂移。
      expect(store.updateRoleProfile(peer.profileId, { name: '同学', persona: '', explanation: 'rigorous' }).configVersion).toBe(2);
    });

    it('run 冻结记录角色配置摘要，角色变更不影响知识点准入结论', () => {
      const knowledgeId = addKnowledge('定义');
      const admissionBefore = store.checkAdmission([knowledgeId], 'formal');
      store.createRoleProfile('teacher', { name: '教师', persona: '严格但简洁', explanation: 'rigorous' });

      buildDraft();
      confirmPlanWith([knowledgeId]);
      const run = store.startPlanRun(projectId).run;
      expect(run.frozen.roleConfigDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(store.checkAdmission([knowledgeId], 'formal')).toEqual(admissionBefore);
    });
  });
});
