import { z } from 'zod';
import {
  PLAN_PAYLOAD_VERSION,
  StudyError,
  planPayloadSchema,
  projectScopeSchema,
  type PlanPayloadDto,
} from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';
import { buildKnowledgeView } from '../../../../lib/server/views';

export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('action', [
  z.object({ scope: projectScopeSchema, action: z.literal('generate') }),
  z.object({
    scope: projectScopeSchema,
    action: z.literal('confirm-task'),
    knowledgeId: z.string().min(1),
    decision: z.enum(['accept', 'reject']),
  }),
  z.object({ scope: projectScopeSchema, action: z.literal('confirm') }),
]);

/**
 * 备考计划：计划是独立产物，通过知识点编号引用清单。
 *
 * 三段动作：生成草案 → 逐条人工确认任务 → 确认整个版本。只有已确认版本可以进入 run，
 * 而确认时未被人接受的任务会转入待核范围，不会作为正式任务下发。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  const session = assertScope(body.scope);
  const projectId = session.projectId;
  const store = session.store;

  if (body.action === 'generate') {
    const project = store.getProject(projectId);
    if (!project) throw new StudyError('NOT_FOUND', { projectId });
    const view = buildKnowledgeView(session);
    const knowledge = view.rows;
    const tasks: PlanPayloadDto['tasks'] = [];
    const gaps: PlanPayloadDto['gaps'] = [];

    for (const point of knowledge) {
      if (view.admittedIds.has(point.knowledgeId)) {
        tasks.push({
          knowledgeId: point.knowledgeId,
          name: point.name,
          minutes: Math.max(20, Math.round((project.dailyMinutes || 60) / Math.max(1, knowledge.length))),
          acceptance: point.acceptance || '完成一节课程与独立练习',
          evidence: point.evidence.map((item) => ({ materialId: item.materialId, segmentId: item.segmentId })),
        });
      } else {
        const blocked = view.blockedById.get(point.knowledgeId);
        gaps.push({
          knowledgeId: point.knowledgeId,
          name: point.name,
          code: blocked?.code ?? 'KNOWLEDGE_NOT_VERIFIED',
          missing: blocked?.missing ?? [],
        });
      }
    }

    const latest = store.getLatestPlan(projectId);
    const version = (latest?.version ?? 0) + 1;
    const payload = planPayloadSchema.parse({
      payloadVersion: PLAN_PAYLOAD_VERSION,
      goal: project.goal,
      examDate: project.examDate,
      dailyMinutes: project.dailyMinutes,
      tasks,
      gaps,
      basis:
        tasks.length === 0
          ? '当前没有可准入知识点，计划不包含正式任务；请先完成材料导入与审核。'
          : `由 ${tasks.length} 项已核实知识点生成候选任务；逐条确认后才能确认整版计划。`,
      confirmedTaskKnowledgeIds: [],
    });
    store.savePlanVersion(projectId, version, 'draft', payload);
    return ok({ version, status: 'draft', plan: payload });
  }

  const draft = store.getLatestPlan(projectId);
  if (!draft) throw new StudyError('PLAN_NOT_CONFIRMED', { reason: 'no_plan' });

  if (body.action === 'confirm-task') {
    if (draft.status !== 'draft') {
      throw new StudyError('VERSION_CONFLICT', { reason: 'plan_already_confirmed', version: draft.version });
    }
    const task = draft.payload.tasks.find((item) => item.knowledgeId === body.knowledgeId);
    if (!task) throw new StudyError('NOT_FOUND', { knowledgeId: body.knowledgeId });
    const without = draft.payload.confirmedTaskKnowledgeIds.filter((id) => id !== body.knowledgeId);
    const payload = {
      ...draft.payload,
      confirmedTaskKnowledgeIds: body.decision === 'accept' ? [...without, body.knowledgeId] : without,
    };
    store.savePlanVersion(projectId, draft.version, 'draft', payload);
    return ok({ version: draft.version, status: 'draft', plan: payload });
  }

  // action === 'confirm'
  const confirmedIds = new Set(draft.payload.confirmedTaskKnowledgeIds);
  if (draft.payload.tasks.length === 0 || confirmedIds.size === 0) {
    throw new StudyError(
      'PLAN_NOT_CONFIRMED',
      { reason: 'no_confirmed_tasks' },
      '还没有逐条确认的任务，不能确认整版计划',
    );
  }
  const tasks = draft.payload.tasks.filter((task) => confirmedIds.has(task.knowledgeId));
  const deferred = draft.payload.tasks
    .filter((task) => !confirmedIds.has(task.knowledgeId))
    .map((task) => ({
      knowledgeId: task.knowledgeId,
      name: task.name,
      code: 'TASK_NOT_CONFIRMED',
      missing: ['该任务未逐条确认，暂不进入正式 run'],
    }));
  const payload = {
    ...draft.payload,
    tasks,
    gaps: [...draft.payload.gaps, ...deferred],
    basis: `${tasks.length} 项任务经逐条确认进入正式计划；${deferred.length} 项未确认的任务转入待核范围。`,
  };
  store.savePlanVersion(projectId, draft.version, 'confirmed', payload);
  return ok({ version: draft.version, status: 'confirmed', plan: payload });
});
