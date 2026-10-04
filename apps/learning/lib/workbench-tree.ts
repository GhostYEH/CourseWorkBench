/**
 * 工作台项目树的层级与键盘导航模型（纯函数，便于脱离渲染器验证）。
 *
 * 树只有三层：项目 → 分组 → 条目。分组按实际数据生成，空分组不占位；
 * 条目指向已有页面并带锚点，让「在树里选中」和「在页面上看到同一条记录」一致。
 */

import type { KnowledgePointDto, MaterialDto, ProposalDto, QuestionListItemDto } from '@sew/study-contracts';

export interface TreeLeaf {
  id: string;
  label: string;
  href: string;
  note: string;
}

export interface TreeGroup {
  id: string;
  label: string;
  leaves: TreeLeaf[];
}

export interface ProjectTree {
  rootId: string;
  rootLabel: string;
  rootNote: string;
  groups: TreeGroup[];
}

export interface TreeInput {
  projectId: string;
  projectName: string;
  subject: string;
  materials: MaterialDto[];
  knowledge: Array<KnowledgePointDto & { admission: { allowed: boolean } }>;
  proposals: ProposalDto[];
  questions: QuestionListItemDto[];
  plan: { confirmedVersion: number | null; taskCount: number };
}

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const SOURCE_LABEL: Record<string, string> = {
  verified: '已核实',
  pending: '待核实',
  invalidated: '已失效',
};

/** 条目锚点所在页面：与 workbench-shell 的 section 划分保持一致。 */
const MATERIAL_HREF = '/workbench/materials';
const KNOWLEDGE_HREF = '/workbench/knowledge';
const REVIEW_HREF = '/workbench/review';
const STUDY_HREF = '/workbench/study';
const PLAN_HREF = '/workbench/plan';

export const buildProjectTree = (input: TreeInput): ProjectTree => {
  const groups: TreeGroup[] = [];

  if (input.materials.length > 0) {
    groups.push({
      id: 'group:materials',
      label: '来源材料',
      leaves: input.materials.map((material) => ({
        id: `material:${material.materialId}:r${material.revision}`,
        label: truncate(material.displayName, 28),
        href: `${MATERIAL_HREF}?materialId=${material.materialId}&revision=${material.revision}`,
        note: `r${material.revision} · ${material.segmentCount} 段 · ${
          material.rawArchive.state === 'archived' ? '原文已归档' : '原文未归档'
        }`,
      })),
    });
  }

  const verified = input.knowledge.filter((point) => point.sourceStatus === 'verified');
  if (verified.length > 0) {
    groups.push({
      id: 'group:knowledge',
      label: '已核实知识',
      leaves: verified.map((point) => ({
        id: `knowledge:${point.knowledgeId}`,
        label: truncate(point.name, 28),
        href: `${KNOWLEDGE_HREF}#kp-${point.knowledgeId}`,
        note: `${SOURCE_LABEL[point.sourceStatus] ?? point.sourceStatus} · ${
          point.admission.allowed ? '准入通过' : '准入受阻'
        }`,
      })),
    });
  }

  const pending = input.proposals.filter((proposal) => proposal.status === 'pending' || proposal.status === 'needs_material');
  if (pending.length > 0) {
    groups.push({
      id: 'group:proposals',
      label: '待审候选',
      leaves: pending.map((proposal) => ({
        id: `proposal:${proposal.proposalId}`,
        label: truncate(proposal.name, 28),
        href: `${REVIEW_HREF}#prop-${proposal.proposalId}`,
        note: proposal.mechanical.passed ? '引用可定位，待语义审核' : '缺少支持原文',
      })),
    });
  }

  if (input.questions.length > 0) {
    groups.push({
      id: 'group:questions',
      label: '题目',
      leaves: input.questions.map((question) => ({
        id: `question:${question.questionId}`,
        label: truncate(question.stem, 28),
        href: `${STUDY_HREF}#q-${question.questionId}`,
        // 只用服务端裁定的身份，不展示答案或解析。
        note: question.originLabel,
      })),
    });
  }

  groups.push({
    id: 'group:plan',
    label: '备考计划',
    leaves: [
      input.plan.confirmedVersion === null
        ? {
            id: 'plan:draft',
            label: '计划未确认',
            href: PLAN_HREF,
            note: '草稿不会进入正式课程',
          }
        : {
            id: `plan:v${input.plan.confirmedVersion}`,
            label: `已确认版本 v${input.plan.confirmedVersion}`,
            href: PLAN_HREF,
            note: `${input.plan.taskCount} 个任务`,
          },
    ],
  });

  return {
    rootId: `project:${input.projectId}`,
    rootLabel: truncate(input.projectName, 28),
    rootNote: input.subject || '未设置科目',
    groups,
  };
};

export interface FlatNode {
  id: string;
  level: 1 | 2 | 3;
  label: string;
  href: string | null;
  expandable: boolean;
  expanded: boolean;
}

/** 按展开状态把树拉平成可见序列；顺序即 Tab 焦点序列。 */
export const flattenVisible = (tree: ProjectTree, expanded: ReadonlySet<string>): FlatNode[] => {
  const nodes: FlatNode[] = [{
    id: tree.rootId,
    level: 1,
    label: tree.rootLabel,
    href: null,
    expandable: tree.groups.length > 0,
    expanded: expanded.has(tree.rootId),
  }];
  if (!expanded.has(tree.rootId)) return nodes;

  for (const group of tree.groups) {
    const groupExpanded = expanded.has(group.id);
    nodes.push({
      id: group.id,
      level: 2,
      label: group.label,
      href: null,
      expandable: group.leaves.length > 0,
      expanded: groupExpanded,
    });
    if (!groupExpanded) continue;
    for (const leaf of group.leaves) {
      nodes.push({ id: leaf.id, level: 3, label: leaf.label, href: leaf.href, expandable: false, expanded: false });
    }
  }
  return nodes;
};

/** 找不到当前节点时回到第一个可见节点，避免焦点丢失在已折叠的条目上。 */
const indexOfNode = (flat: readonly FlatNode[], id: string): number => {
  const index = flat.findIndex((node) => node.id === id);
  return index < 0 ? 0 : index;
};

export type VerticalKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

export const moveFocus = (flat: readonly FlatNode[], currentId: string, key: VerticalKey): string => {
  if (flat.length === 0) return currentId;
  const index = indexOfNode(flat, currentId);
  const last = flat.length - 1;
  switch (key) {
    // 末行按下回到第一行（循环），与目录树常见的单向浏览习惯都不冲突。
    case 'ArrowDown':
      return flat[index >= last ? 0 : index + 1]!.id;
    case 'ArrowUp':
      return flat[index <= 0 ? last : index - 1]!.id;
    case 'Home':
      return flat[0]!.id;
    case 'End':
      return flat[last]!.id;
  }
};

const isDescendantOf = (tree: ProjectTree, id: string, ancestorId: string): boolean => {
  let current: string | null = id;
  while (current) {
    if (current === ancestorId) return true;
    current = parentIdOf(tree, current);
  }
  return false;
};

/** 父节点 id：叶子回指分组，分组回指项目根，项目根没有父节点。 */
export const parentIdOf = (tree: ProjectTree, id: string): string | null => {
  if (id === tree.rootId) return null;
  if (id.startsWith('group:')) return tree.rootId;
  const group = tree.groups.find((entry) => entry.leaves.some((leaf) => leaf.id === id));
  return group ? group.id : null;
};

export interface ArrowResult {
  focusId: string;
  expanded: Set<string>;
}

/**
 * ArrowRight/ArrowLeft 的展开折叠语义（WAI-ARIA TreeView 模式）。
 *
 * 折叠的分组展开；展开的分组把焦点送到第一个子节点；叶子上的右箭头不动作，
 * 左箭头优先折叠当前分组，否则回到父节点。
 */
export const navigateWithArrow = (
  tree: ProjectTree,
  flat: readonly FlatNode[],
  expandedIds: ReadonlySet<string>,
  currentId: string,
  key: 'ArrowLeft' | 'ArrowRight',
): ArrowResult => {
  const expanded = new Set(expandedIds);
  const node = flat.find((entry) => entry.id === currentId) ?? flat[0];
  if (!node) return { focusId: currentId, expanded };

  if (key === 'ArrowRight') {
    if (node.expandable && !node.expanded) {
      expanded.add(node.id);
      return { focusId: node.id, expanded };
    }
    if (node.expandable && node.expanded) {
      const child = flat.find((entry) => entry.level === node.level + 1 && isDescendantOf(tree, entry.id, node.id));
      if (child) return { focusId: child.id, expanded };
    }
    return { focusId: node.id, expanded };
  }

  if (node.expandable && node.expanded && node.id !== tree.rootId) {
    expanded.delete(node.id);
    return { focusId: node.id, expanded };
  }
  const parent = parentIdOf(tree, node.id);
  return { focusId: parent ?? node.id, expanded };
};

/** 初始展开：项目根与全部分组，材料条目最多铺一层，避免树一打开就是长列表。 */
export const defaultExpandedIds = (tree: ProjectTree): Set<string> =>
  new Set([tree.rootId, ...tree.groups.map((group) => group.id)]);
