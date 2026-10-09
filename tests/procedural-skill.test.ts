import { describe, expect, it } from 'vitest';
import {
  formalInteractionDefinitionSchema,
  formalInteractionPublicDefinitionSchema,
  type FormalInteractionDefinitionDto,
} from '@sew/study-contracts';
import { proceduralSkillCheck, publicFormalInteractionDefinition } from '@sew/study-domain';
import { parseProceduralSkillDraft } from '../apps/learning/lib/procedural-skill-authoring';

/**
 * 步骤技能训练（OMA-085）。
 *
 * 固定：① 公开投影去掉每步正确工具与正确步骤顺序（不泄漏答案）；② 服务端逐步骤核验「顺序 + 工具」，
 * 非法执行序列（重复/遗漏/未知工具）返回 null；③ 作者解析把行顺序当正确顺序、工具序号映射到稳定 id。
 */

const definition: FormalInteractionDefinitionDto = {
  id: 'procedural',
  kind: 'procedural_skill',
  title: '断电与验电',
  statementIds: ['st_1'],
  procedureType: 'operation',
  task: '完成断电确认与验电',
  tools: [
    { id: 't1', label: '绝缘手套' },
    { id: 't2', label: '验电器' },
    { id: 't3', label: '万用表' },
  ],
  steps: [
    {
      id: 's1',
      label: '断开总闸',
      correctToolId: 't1',
      successCriteria: '开关处于断开位',
      errorConsequences: '带电操作导致触电',
    },
    {
      id: 's2',
      label: '验电确认无电压',
      correctToolId: 't2',
      successCriteria: '验电器无指示',
      errorConsequences: '误判带电状态',
    },
    {
      id: 's3',
      label: '测量确认',
      correctToolId: 't3',
      successCriteria: '读数为 0V',
      errorConsequences: '带残留电压作业',
    },
  ],
  correctOrder: ['s1', 's2', 's3'],
};

describe('OMA-085 步骤技能训练', () => {
  it('定义合同接受 procedural_skill，公开投影去掉正确工具与正确步骤顺序', () => {
    expect(formalInteractionDefinitionSchema.safeParse(definition).success).toBe(true);
    const shared = publicFormalInteractionDefinition(definition);
    expect(formalInteractionPublicDefinitionSchema.safeParse(shared).success).toBe(true);
    const serialized = JSON.stringify(shared);
    expect(serialized).not.toContain('correctToolId');
    expect(serialized).not.toContain('correctOrder');
    // 判据与后果对本人可见（不是答案）。
    expect(shared.kind).toBe('procedural_skill');
    if (shared.kind === 'procedural_skill') {
      expect(shared.steps.every((step) => step.successCriteria.length > 0)).toBe(true);
    }
  });

  it('逐步骤核验顺序与工具，非法执行序列返回 null', () => {
    const allCorrect = proceduralSkillCheck(
      [
        { stepId: 's1', toolId: 't1' },
        { stepId: 's2', toolId: 't2' },
        { stepId: 's3', toolId: 't3' },
      ],
      definition,
    );
    expect(allCorrect.allCorrect).toBe(true);

    // 顺序错（后两步互换）：整份仍合法，但 allCorrect=false，且对应步骤 orderCorrect=false。
    const wrongOrder = proceduralSkillCheck(
      [
        { stepId: 's1', toolId: 't1' },
        { stepId: 's3', toolId: 't3' },
        { stepId: 's2', toolId: 't2' },
      ],
      definition,
    );
    expect(wrongOrder.steps).not.toBeNull();
    expect(wrongOrder.allCorrect).toBe(false);
    expect(wrongOrder.steps![1]).toMatchObject({ stepId: 's3', orderCorrect: false });
    expect(wrongOrder.steps![2]).toMatchObject({ stepId: 's2', orderCorrect: false });

    // 工具错：某步选了非正确工具。
    const wrongTool = proceduralSkillCheck(
      [
        { stepId: 's1', toolId: 't1' },
        { stepId: 's2', toolId: 't3' },
        { stepId: 's3', toolId: 't3' },
      ],
      definition,
    );
    expect(wrongTool.allCorrect).toBe(false);
    expect(wrongTool.steps![1]).toMatchObject({ stepId: 's2', toolCorrect: false });

    // 重复步骤：整份非法。
    expect(
      proceduralSkillCheck(
        [
          { stepId: 's1', toolId: 't1' },
          { stepId: 's1', toolId: 't1' },
          { stepId: 's2', toolId: 't2' },
        ],
        definition,
      ).steps,
    ).toBeNull();
    // 未知工具：整份非法。
    expect(
      proceduralSkillCheck(
        [
          { stepId: 's1', toolId: 't9' },
          { stepId: 's2', toolId: 't2' },
          { stepId: 's3', toolId: 't3' },
        ],
        definition,
      ).steps,
    ).toBeNull();
  });

  it('作者解析：行顺序即正确顺序，工具序号映射到稳定 id', () => {
    const draft = parseProceduralSkillDraft(
      '绝缘手套\n验电器\n万用表',
      '断开总闸 | 1 | 开关断开 | 触电\n验电 | 2 | 无指示 | 误判\n测量 | 3 | 0V | 残留电压',
    );
    expect(draft.tools.map((tool) => tool.id)).toEqual(['t1', 't2', 't3']);
    expect(draft.steps.map((step) => step.correctToolId)).toEqual(['t1', 't2', 't3']);
    expect(draft.correctOrder).toEqual(['s1', 's2', 's3']);
    // 缺字段或越界工具序号的行被忽略。
    const sparse = parseProceduralSkillDraft('甲\n乙', '步骤A | 1\n步骤B | 9 | 判据 | 后果');
    expect(sparse.steps).toHaveLength(1);
    expect(sparse.steps[0]).toMatchObject({ correctToolId: 't1' });
  });
});
