import { describe, expect, it } from 'vitest';
import type {
  KnowledgePointDto, MaterialDto, ProposalDto, QuestionListItemDto,
} from '@sew/study-contracts';
import {
  buildProjectTree, defaultExpandedIds, flattenVisible, moveFocus, navigateWithArrow, parentIdOf,
} from '../apps/learning/lib/workbench-tree';

/**
 * 项目树层级与键盘导航模型。
 *
 * 这里固定的是「树里选中的记录」与「页面上看到的记录」一致所需的结构：
 * 分组只包含实际存在的条目，方向键的展开折叠语义符合 TreeView 约定，
 * 且树永不把答案或解析作为标签暴露出来。
 */

const material = (id: string, revision = 1): MaterialDto => ({
  materialId: id,
  displayName: `教材${id}`,
  type: 'md',
  revision,
  recordScope: 'formal',
  readableLocation: '第一章',
  importedAt: '2026-10-04T00:00:00.000Z',
  segmentCount: 3,
  normalizationVersion: 'norm-1',
  fingerprint: 'f'.repeat(64),
  referencedByKnowledge: 1,
  rawArchive: { state: 'archived', sha256: 'a'.repeat(64), byteLength: 128, mediaType: 'text/markdown', originalName: `${id}.md`, archivedAt: '2026-10-04T00:00:00.000Z' },
  examVerification: null,
});

const knowledge = (id: string, allowed: boolean): KnowledgePointDto & { admission: { allowed: boolean } } => ({
  knowledgeId: id,
  name: `知识点${id}`,
  concept: '概念',
  conditions: '',
  sourceStatus: 'verified',
  recordScope: 'formal',
  reviewProvenance: 'user_semantic',
  scopeStatus: 'in_syllabus',
  masteryStatus: 'untested',
  syllabusItemId: null,
  syllabusRequirementKey: null,
  prerequisites: [],
  evidence: [],
  acceptance: '',
  priority: 'medium',
  revision: 0,
  admission: { allowed },
});

const proposal = (id: string, passed: boolean): ProposalDto => ({
  proposalId: id,
  name: `候选${id}`,
  concept: '概念',
  conditions: '',
  scopeStatus: 'in_syllabus',
  recordScope: 'formal',
  prerequisites: [],
  evidence: [],
  acceptance: '',
  priority: 'medium',
  proposedBy: 'ai',
  status: 'pending',
  mechanical: { passed, checks: [] },
  createdAt: '2026-10-04T00:00:00.000Z',
  reviewedAt: null,
  reviewNote: null,
  reviewProvenance: null,
  revision: 0,
});

const question = (id: string): QuestionListItemDto => ({
  assessment: null,
  questionId: id,
  stem: `题干${id}：判断函数在区间上的单调性`,
  knowledgeIds: ['kp1'],
  origin: 'ai_new',
  originLabel: 'AI 新编题',
  originDetail: null,
  recordScope: 'formal',
  revision: 1,
});

const fullTree = () =>
  buildProjectTree({
    projectId: 'proj-1',
    projectName: '数学必修一',
    subject: '数学',
    materials: [material('m1'), material('m2')],
    knowledge: [knowledge('kp1', true), knowledge('kp2', false)],
    proposals: [proposal('p1', true)],
    questions: [question('q1')],
    plan: { confirmedVersion: 2, taskCount: 5 },
  });

describe('项目树层级', () => {
  it('分组按实际数据生成，顺序为材料、知识、候选、题目、计划', () => {
    const tree = fullTree();
    expect(tree.rootLabel).toBe('数学必修一');
    expect(tree.groups.map((group) => group.id)).toEqual([
      'group:materials', 'group:knowledge', 'group:proposals', 'group:questions', 'group:plan',
    ]);
    expect(tree.groups[0]?.leaves.map((leaf) => leaf.id)).toEqual(['material:m1:r1', 'material:m2:r1']);
    expect(tree.groups[1]?.leaves[1]?.note).toContain('准入受阻');
    expect(tree.groups[4]?.leaves[0]?.label).toBe('已确认版本 v2');
  });

  it('没有数据时只保留计划分组，不生成空分组占位', () => {
    const tree = buildProjectTree({
      projectId: 'proj-1', projectName: '新项目', subject: '',
      materials: [], knowledge: [], proposals: [], questions: [],
      plan: { confirmedVersion: null, taskCount: 0 },
    });
    expect(tree.groups.map((group) => group.id)).toEqual(['group:plan']);
    expect(tree.groups[0]?.leaves[0]).toMatchObject({ label: '计划未确认', note: '草稿不会进入正式课程' });
    expect(tree.rootNote).toBe('未设置科目');
  });

  it('题目节点只带服务端身份标签，不出现答案或解析字段', () => {
    const leaves = flattenVisible(fullTree(), defaultExpandedIds(fullTree()));
    const tree = fullTree();
    const questionLeaves = tree.groups.find((group) => group.id === 'group:questions')!.leaves;
    expect(questionLeaves[0]?.note).toBe('AI 新编题');
    expect(JSON.stringify(questionLeaves)).not.toMatch(/"(answer|solution)"/);
    expect(leaves.some((node) => node.label.includes('答案'))).toBe(false);
  });

  it('候选条目区分「引用可定位」与「缺少支持原文」，不写成内容正确', () => {
    const tree = buildProjectTree({
      projectId: 'p', projectName: '项目', subject: '数学',
      materials: [], knowledge: [], questions: [], plan: { confirmedVersion: null, taskCount: 0 },
      proposals: [proposal('p-pass', true), proposal('p-fail', false)],
    });
    const notes = tree.groups.find((group) => group.id === 'group:proposals')!.leaves.map((leaf) => leaf.note);
    expect(notes).toEqual(['引用可定位，待语义审核', '缺少支持原文']);
  });
});

describe('可见序列与焦点移动', () => {
  it('折叠项目根时只剩根节点；展开后层级为 1/2/3', () => {
    const tree = fullTree();
    // 展开集合表示「该节点的子节点可见」，所以空集合只剩根。
    expect(flattenVisible(tree, new Set<string>([]))).toHaveLength(1);
    expect(flattenVisible(tree, new Set<string>([tree.rootId]))).toHaveLength(6);

    const flat = flattenVisible(tree, defaultExpandedIds(tree));
    expect(flat[0]).toMatchObject({ level: 1, expandable: true, expanded: true });
    expect(flat[1]).toMatchObject({ level: 2, id: 'group:materials' });
    expect(flat[2]).toMatchObject({ level: 3, id: 'material:m1:r1' });
    // 折叠某个分组后其子节点从序列中消失，但兄弟分组仍在。
    const collapsed = new Set(defaultExpandedIds(tree));
    collapsed.delete('group:knowledge');
    const afterCollapse = flattenVisible(tree, collapsed);
    expect(afterCollapse.some((node) => node.id === 'knowledge:kp1')).toBe(false);
    expect(afterCollapse.some((node) => node.id === 'question:q1')).toBe(true);
  });

  it('上下键在可见序列内循环，Home/End 落到首尾', () => {
    const tree = fullTree();
    const flat = flattenVisible(tree, defaultExpandedIds(tree));
    const first = flat[0]!.id;
    const last = flat[flat.length - 1]!.id;
    expect(moveFocus(flat, first, 'ArrowUp')).toBe(last);
    expect(moveFocus(flat, last, 'ArrowDown')).toBe(first);
    expect(moveFocus(flat, 'knowledge:kp1', 'ArrowDown')).toBe('knowledge:kp2');
    expect(moveFocus(flat, 'knowledge:kp2', 'ArrowUp')).toBe('knowledge:kp1');
    expect(moveFocus(flat, 'question:q1', 'Home')).toBe(first);
    expect(moveFocus(flat, 'question:q1', 'End')).toBe(last);
  });

  it('焦点所在节点被折叠掉时回到第一个可见节点，不丢焦点', () => {
    const tree = fullTree();
    const flat = flattenVisible(tree, defaultExpandedIds(tree));
    expect(moveFocus(flat, 'knowledge:kp1', 'Home')).toBe(flat[0]!.id);
  });

  it('右箭头先展开折叠分组，再次按下才进入第一个子节点；左箭头先折叠再回父节点', () => {
    const tree = fullTree();
    const onlyRoot = new Set<string>([tree.rootId]);
    // 根展开即分组可见，但各分组仍折叠。
    const flatGroupsWithRoot = flattenVisible(tree, onlyRoot);

    // 根已展开时按右箭头直接进入第一个分组；分组仍折叠。
    const ontoGroup = navigateWithArrow(tree, flatGroupsWithRoot, onlyRoot, tree.rootId, 'ArrowRight');
    expect(ontoGroup.focusId).toBe('group:materials');
    const flatWithGroups = flattenVisible(tree, ontoGroup.expanded);
    expect(flatWithGroups.map((node) => node.id).slice(0, 3)).toEqual([tree.rootId, 'group:materials', 'group:knowledge']);

    // 第一次按右箭头：展开当前分组，焦点保持。
    const expandGroup = navigateWithArrow(tree, flatWithGroups, ontoGroup.expanded, 'group:materials', 'ArrowRight');
    expect(expandGroup.focusId).toBe('group:materials');
    expect(expandGroup.expanded.has('group:materials')).toBe(true);

    // 第二次按右箭头：焦点进入第一个子节点。
    const flatExpanded = flattenVisible(tree, expandGroup.expanded);
    const intoChild = navigateWithArrow(tree, flatExpanded, expandGroup.expanded, 'group:materials', 'ArrowRight');
    expect(intoChild.focusId).toBe('material:m1:r1');

    // 叶子上的左箭头：把焦点交还给父分组，分组保持展开（TreeView 约定）。
    const toParent = navigateWithArrow(tree, flatExpanded, expandGroup.expanded, 'material:m2:r1', 'ArrowLeft');
    expect(toParent.focusId).toBe('group:materials');
    expect(toParent.expanded.has('group:materials')).toBe(true);

    // 分组自身上的左箭头：折叠分组，焦点留在分组上。
    const collapseGroup = navigateWithArrow(tree, flatExpanded, expandGroup.expanded, 'group:materials', 'ArrowLeft');
    expect(collapseGroup.focusId).toBe('group:materials');
    expect(collapseGroup.expanded.has('group:materials')).toBe(false);

    // 项目根上的左箭头：没有父节点也不折叠自己。
    const rootStays = navigateWithArrow(tree, flatExpanded, expandGroup.expanded, tree.rootId, 'ArrowLeft');
    expect(rootStays.focusId).toBe(tree.rootId);
    expect(rootStays.expanded.has(tree.rootId)).toBe(true);
  });

  it('父节点关系只到三层，叶子回指分组、分组回指项目根', () => {
    const tree = fullTree();
    expect(parentIdOf(tree, 'material:m1:r1')).toBe('group:materials');
    expect(parentIdOf(tree, 'group:plan')).toBe(tree.rootId);
    expect(parentIdOf(tree, tree.rootId)).toBeNull();
    expect(parentIdOf(tree, '不存在的节点')).toBeNull();
  });
});
