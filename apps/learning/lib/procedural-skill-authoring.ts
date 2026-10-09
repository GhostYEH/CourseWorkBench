/**
 * 步骤技能训练的作者输入解析（OMA-085）。
 *
 * 与排序条目一样：作者按行输入步骤与工具，**行顺序即正确执行顺序**，且每步声明它应使用的工具。
 * 这里给步骤与工具生成不编码答案位置的身份（`s1`/`t1`…），并把「每步正确工具」与「正确步骤顺序」
 * 留在私有定义里，公开投影只给打乱后的步骤与工具集合。
 */

export interface ProceduralToolDraft {
  id: string;
  label: string;
}

export interface ProceduralStepDraft {
  id: string;
  label: string;
  correctToolId: string;
  successCriteria: string;
  errorConsequences: string;
}

export interface ProceduralSkillDraft {
  tools: ProceduralToolDraft[];
  steps: ProceduralStepDraft[];
  /** 正确执行顺序（`steps.id` 的一个排列），即作者输入的行顺序。 */
  correctOrder: string[];
}

/**
 * 解析工具与步骤输入。
 *
 * - `toolsText`：每行一个工具标签，顺序编号 `t1`、`t2`…
 * - `stepsText`：每行一个步骤，格式 `步骤标签 | 工具序号(1 起) | 成功判据 | 错误后果`；
 *   行顺序即正确执行顺序。缺少字段的行被忽略（界面另有提示）。
 */
export const parseProceduralSkillDraft = (
  toolsText: string,
  stepsText: string,
): ProceduralSkillDraft => {
  const tools = toolsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label, index) => ({ id: `t${index + 1}`, label }));
  const steps: ProceduralStepDraft[] = [];
  for (const line of stepsText.split('\n')) {
    if (!line.trim()) continue;
    const [label = '', toolIndex = '', successCriteria = '', errorConsequences = ''] = line
      .split('|')
      .map((part) => part.trim());
    if (!label || !toolIndex) continue;
    const index = Number(toolIndex);
    const tool = tools[index - 1];
    if (!Number.isInteger(index) || !tool) continue;
    steps.push({
      id: `s${steps.length + 1}`,
      label,
      correctToolId: tool.id,
      successCriteria: successCriteria || '按判据确认本步达到要求',
      errorConsequences: errorConsequences || '跳过或违规将导致后续步骤无法完成',
    });
  }
  return { tools, steps, correctOrder: steps.map((step) => step.id) };
};
