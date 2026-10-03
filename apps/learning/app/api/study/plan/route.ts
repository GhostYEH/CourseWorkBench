import { z } from 'zod';
import { StudyError, projectScopeSchema } from '@sew/study-contracts';
import { parseBody, route, ok } from '../../../../lib/server/http';
import { assertScope } from '../../../../lib/server/service';
import { buildKnowledgeView } from '../../../../lib/server/views';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  scope: projectScopeSchema,
  action: z.enum(['generate', 'confirm']),
});

interface PlanTask {
  knowledgeId: string;
  name: string;
  minutes: number;
  acceptance: string;
  evidence: Array<{ materialId: string; segmentId: string }>;
}

interface PlanPayload {
  goal: string;
  examDate: string | null;
  dailyMinutes: number;
  tasks: PlanTask[];
  /** 材料缺口与待核范围：未经核实的部分不能作为已确定任务下发。 */
  gaps: Array<{ knowledgeId: string; name: string; code: string; missing: string[] }>;
  basis: string;
}

/**
 * 备考计划：计划是独立产物，通过知识点编号引用清单。
 * 只有准入通过的知识点才生成正式任务；被阻断的进入「待核范围」。
 */
export const POST = route(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  const session = assertScope(body.scope);
  const project = session.store.getProject(session.projectId);
  if (!project) throw new StudyError('NOT_FOUND', { projectId: session.projectId });

  const view = buildKnowledgeView(session);
  const knowledge = view.rows;
  const tasks: PlanTask[] = [];
  const gaps: PlanPayload['gaps'] = [];

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

  const latest = session.store.getLatestPlan<PlanPayload>(session.projectId);
  const version = (latest?.version ?? 0) + 1;

  const payload: PlanPayload = {
    goal: project.goal,
    examDate: project.examDate,
    dailyMinutes: project.dailyMinutes,
    tasks,
    gaps,
    basis:
      tasks.length === 0
        ? '当前没有可准入知识点，计划不包含正式任务；请先完成材料导入与审核。'
        : `由 ${tasks.length} 项已核实知识点生成；${gaps.length} 项因来源或范围问题留在待核范围。`,
  };

  if (body.action === 'generate') {
    session.store.savePlanVersion(session.projectId, version, 'draft', payload);
    return ok({ version, status: 'draft', plan: payload });
  }

  if (tasks.length === 0) {
    throw new StudyError('PLAN_NOT_CONFIRMED', { reason: 'no_admitted_knowledge' }, '没有可准入知识点，不能确认计划');
  }
  const baseVersion = latest?.status === 'draft' ? latest.version : version;
  if (latest?.status !== 'draft') {
    session.store.savePlanVersion(session.projectId, baseVersion, 'draft', payload);
  }
  session.store.savePlanVersion(session.projectId, baseVersion, 'confirmed', payload);
  return ok({ version: baseVersion, status: 'confirmed', plan: payload });
});
