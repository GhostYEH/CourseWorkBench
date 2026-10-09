export interface StudyProgress {
  hasGoal: boolean;
  materials: number;
  pending: number;
  admitted: number;
  hasPlan: boolean;
  hasClassroom: boolean;
}

/** One concrete next action, based on usable content rather than raw record counts. */
export function studyNextStep(progress: StudyProgress) {
  if (!progress.hasGoal)
    return {
      title: '设定备考目标',
      description: '填写科目、学习目标和每天可用的时间。',
      href: '#study-goal-entry',
      action: '填写目标',
    };
  if (progress.materials === 0)
    return {
      title: '导入你的学习材料',
      description: '上传考纲、教材或讲义，课程会以这些材料为依据。',
      href: '/workbench/materials',
      action: '导入材料',
    };
  if (progress.admitted === 0)
    return progress.pending > 0
      ? {
          title: '检查教材原文与知识点',
          description: '对照原文确认知识点，确认后才能用于课程和练习。',
          href: '/workbench/review',
          action: '检查知识点',
        }
      : {
          title: '整理要学习的知识点',
          description: '从材料中提出知识点；已有知识点来源失效时，先补充有效材料并重新核对。',
          href: '/workbench/knowledge?tab=candidates',
          action: '整理知识点',
        };
  if (!progress.hasPlan)
    return {
      title: '制定你的备考计划',
      description: '根据已确认的知识点安排学习任务，检查后确认计划。',
      href: '/workbench/plan',
      action: '制定计划',
    };
  if (!progress.hasClassroom)
    return {
      title: '准备第一节互动课',
      description: '按计划生成课程，检查讲解与课件，再发布并进入课堂。',
      href: '/workbench/lessons',
      action: '准备课程',
    };
  return {
    title: '继续上课与练习',
    description: '进入已发布课程听讲解、参与互动，或用练习巩固所学。',
    href: '/workbench/lessons',
    action: '进入课堂',
  };
}
