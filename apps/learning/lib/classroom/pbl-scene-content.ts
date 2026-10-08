import type { PBLContent, PBLProject } from '@openmaic/dsl';
import type { PblFrozenDto } from '@sew/study-contracts';
import { publicPblProjectDefinition } from '@sew/study-domain';

/**
 * A classroom PBL scene contains only the public design projection. Runtime state,
 * learner drafts, rubric descriptions and rubric IDs remain in their own services.
 */
export const pblSceneContent = (
  frozen: PblFrozenDto,
  frozenAt: string,
): PBLContent & { definitionId: string; statementIds: string[] } => {
  const definition = publicPblProjectDefinition(frozen.definition);
  const timestamp = Number.isFinite(Date.parse(frozenAt))
    ? new Date(frozenAt).toISOString()
    : new Date(0).toISOString();
  const tasksById = new Map(definition.tasks.map((task, index) => [task.id, { task, index }]));
  const projectV2: PBLProject = {
    uiPhase: 'hero',
    title: definition.title,
    description: [
      definition.background,
      `面向对象：${definition.authenticContext.audience}`,
      `要解决的问题：${definition.authenticContext.problem}`,
      `约束：${definition.authenticContext.constraints.join('；')}`,
    ].join('\n\n'),
    learningObjective: definition.goals.map((goal) => goal.statement).join('；'),
    gains: definition.goals.map((goal) => goal.successDescription),
    tags: [],
    language: 'zh-CN',
    scenario: {
      setting: definition.authenticContext.audience,
      goal: definition.authenticContext.problem,
      rules: definition.authenticContext.constraints.join('；'),
      characters: [],
    },
    proficiency: '',
    status: 'active',
    roles: definition.roles.map((role) => ({
      id: role.id,
      type:
        role.kind === 'learner' ? 'user' : role.kind === 'mentor' ? 'instructor' : 'collaborator',
      name: role.name,
      description: role.responsibilities.join('；'),
    })),
    milestones: definition.milestones.map((milestone, milestoneIndex) => ({
      id: milestone.id,
      title: milestone.title,
      description: milestone.checks.map((check) => check.expectation).join('；'),
      status: milestoneIndex === 0 ? 'active' : 'locked',
      order: milestone.order,
      microtasks: milestone.taskIds.flatMap((taskId) => {
        const entry = tasksById.get(taskId);
        if (!entry) return [];
        const task = entry.task;
        return [
          {
            id: task.id,
            title: task.title,
            description: task.outcome,
            status: 'todo' as const,
            assignee: 'user' as const,
            hints: task.checks.map((check) => check.expectation),
            order: entry.index + 1,
            completionCriteria: task.checks.map((check) => check.expectation).join('；'),
          },
        ];
      }),
    })),
    submissions: [],
    evaluations: [],
    threads: [],
    engagementEvents: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    type: 'pbl',
    definitionId: definition.id,
    statementIds: [...definition.statementIds],
    projectV2,
  };
};
