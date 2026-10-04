'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type {
  KnowledgePointDto, MaterialDto, PreferencesDto, ProposalDto, QuestionListItemDto, WorkbenchStateDto,
} from '@sew/study-contracts';
import { applyThemeToDocument, useAppStore } from '../lib/client';
import {
  buildProjectTree, defaultExpandedIds, flattenVisible, moveFocus, navigateWithArrow,
  type FlatNode,
} from '../lib/workbench-tree';
import { ProjectActions } from './project-actions';
import { ModelConnectionIndicator } from './model-connection-settings';

interface ShellProps {
  state: WorkbenchStateDto;
  materials: MaterialDto[];
  proposals: ProposalDto[];
  questions: QuestionListItemDto[];
  knowledge: Array<KnowledgePointDto & { admission: { allowed: boolean } }>;
  preferences: PreferencesDto;
  children: ReactNode;
}

const NAV = [
  { key: 'project', label: '项目', glyph: '▤', href: '/workbench' },
  { key: 'knowledge', label: '知识', glyph: '◆', href: '/workbench/knowledge' },
  { key: 'review', label: '来源审核', glyph: '✓', href: '/workbench/review' },
  { key: 'plan', label: '计划', glyph: '▦', href: '/workbench/plan' },
  { key: 'lesson', label: '课程', glyph: '▥', href: '/workbench/lessons' },
  { key: 'study', label: '学习', glyph: '✎', href: '/workbench/study' },
  { key: 'mistakes', label: '错题', glyph: '✗', href: '/workbench/mistakes' },
  { key: 'eval', label: '评测', glyph: '◎', href: '/workbench/eval' },
] as const;

const SECTION_TABS: Record<string, Array<{ label: string; href: string }>> = {
  project: [
    { label: '总览', href: '/workbench' },
    { label: '材料与来源', href: '/workbench/materials' },
    { label: '科目设置', href: '/workbench/settings' },
    { label: '个人档案与 UID', href: '/profile' },
    { label: '外观与阅读', href: '/workbench/appearance' },
  ],
  knowledge: [
    { label: '已确认知识', href: '/workbench/knowledge' },
    { label: '生成准入自检', href: '/workbench/knowledge?tab=admission' },
    { label: '考纲条目与覆盖', href: '/workbench/syllabus' },
  ],
  review: [
    { label: '独立来源审核', href: '/workbench/review' },
    { label: '材料与来源', href: '/workbench/materials' },
  ],
  plan: [{ label: '备考计划', href: '/workbench/plan' }],
  lesson: [{ label: '课程与证据包', href: '/workbench/lessons' }],
  study: [
    { label: '今日学习', href: '/workbench/study' },
    { label: '课堂与成员', href: '/workbench/rooms' },
    { label: '课堂演示', href: '/classroom/lesson-demo-monotonicity-1' },
  ],
  mistakes: [
    { label: '错题本', href: '/workbench/mistakes' },
    { label: '模拟数据', href: '/workbench/mistakes?tab=simulation' },
  ],
  eval: [{ label: '指标与用例', href: '/workbench/eval' }],
};

const sectionOf = (pathname: string): string => {
  const segment = pathname.split('/')[2] ?? '';
  if (['materials', 'settings', 'appearance'].includes(segment)) return 'project';
  if (segment === 'syllabus') return 'knowledge';
  if (segment === 'lessons') return 'lesson';
  if (segment === 'rooms') return 'study';
  if (['knowledge', 'review', 'plan', 'study', 'mistakes', 'eval'].includes(segment)) return segment;
  return 'project';
};

export const WorkbenchShell = ({
  state, materials, proposals, questions, knowledge, preferences, children,
}: ShellProps) => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const panels = useAppStore((s) => s.panels);
  const toggleTree = useAppStore((s) => s.toggleTree);
  const toggleRight = useAppStore((s) => s.toggleRight);
  const toggleBottom = useAppStore((s) => s.toggleBottom);
  const setRightTab = useAppStore((s) => s.setRightTab);

  const section = sectionOf(pathname);

  useEffect(() => {
    applyThemeToDocument(preferences);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyThemeToDocument(preferences);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preferences]);

  const pendingProposals = useMemo(
    () => proposals.filter((p) => p.status === 'pending' || p.status === 'needs_material'),
    [proposals],
  );

  const projectTree = useMemo(
    () => buildProjectTree({
      projectId: state.project.projectId,
      projectName: state.project.displayName,
      subject: state.project.subject,
      materials,
      knowledge,
      proposals,
      questions,
      plan: state.plan,
    }),
    [state.project, state.plan, materials, knowledge, proposals, questions],
  );

  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpandedIds(projectTree));
  const [focusId, setFocusId] = useState<string>(projectTree.rootId);
  const focusPending = useRef(false);
  const nodeRefs = useRef(new Map<string, HTMLLIElement>());
  const visibleNodes = useMemo(() => flattenVisible(projectTree, expanded), [projectTree, expanded]);

  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    nodeRefs.current.get(focusId)?.focus();
  }, [focusId, expanded]);

  const toggleNode = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * 树内键盘导航：方向键移动焦点与展开折叠，Enter/空格激活条目。
   * 语义由 lib/workbench-tree 提供，便于脱离渲染器验证。
   */
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault();
      focusPending.current = true;
      setFocusId(moveFocus(visibleNodes, focusId, key));
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      const next = navigateWithArrow(projectTree, visibleNodes, expanded, focusId, key);
      focusPending.current = true;
      setExpanded(next.expanded);
      setFocusId(next.focusId);
      return;
    }
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      const node = visibleNodes.find((entry) => entry.id === focusId);
      if (!node) return;
      event.preventDefault();
      if (node.expandable) {
        toggleNode(node.id);
        return;
      }
      if (node.href) router.push(node.href);
    }
  };

  const registerNode = (id: string) => (element: HTMLLIElement | null): void => {
    if (element) nodeRefs.current.set(id, element);
    else nodeRefs.current.delete(id);
  };

  const nodeProps = (node: FlatNode): {
    ref: (element: HTMLLIElement | null) => void;
    className: string;
    role: 'treeitem';
    'aria-level': number;
    'aria-selected': boolean;
    'aria-expanded'?: boolean;
    tabIndex: number;
  } => ({
    ref: registerNode(node.id),
    className: 'tree-node',
    role: 'treeitem',
    'aria-level': node.level,
    'aria-selected': focusId === node.id,
    ...(node.expandable ? { 'aria-expanded': expanded.has(node.id) } : {}),
    tabIndex: focusId === node.id ? 0 : -1,
  });

  const rootNode = visibleNodes[0];
  const tabs = SECTION_TABS[section] ?? [];
  const queryString = searchParams.toString();
  const currentUrl = queryString ? `${pathname}?${queryString}` : pathname;

  const draftLabel =
    state.counts.proposalsPending > 0 ? `草稿：${state.counts.proposalsPending} 项待审` : '草稿：无待提交';

  return (
    <div className="shell" data-density={preferences.density}>
      <header className="shell-top">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            页
          </span>
          学科备考工作台
        </span>
        <span className="top-project">
          <strong title={state.project.displayPath}>{state.project.displayName}</strong>
          <span className="muted mono">#{state.project.generation}</span>
        </span>
        <div className="top-actions">
          <button type="button" className="btn btn-ghost" onClick={toggleTree} aria-pressed={panels.tree}>
            项目树
          </button>
          <Link className="btn btn-ghost" href="/workbench/materials">
            导入材料
          </Link>
          <Link className="btn" href="/workbench/review">
            来源审核{pendingProposals.length > 0 ? `（${pendingProposals.length}）` : ''}
          </Link>
          <ProjectActions mode="manage" />
          <button type="button" className="btn btn-ghost" onClick={toggleRight} aria-pressed={panels.right}>
            侧栏
          </button>
        </div>
      </header>

      <div className="shell-body">
        <nav className="activity" aria-label="主导航">
          {NAV.map((item) => (
            <Link
              key={item.key}
              className="activity-item"
              href={item.href}
              data-active={section === item.key}
              aria-current={section === item.key ? 'page' : undefined}
            >
              <span className="activity-glyph" aria-hidden="true">
                {item.glyph}
              </span>
              {item.label}
            </Link>
          ))}
          <span className="activity-spacer" />
          <Link className="activity-item" href="/workbench/appearance" data-active={pathname === '/workbench/appearance'}>
            <span className="activity-glyph" aria-hidden="true">
              ⚙
            </span>
            设置
          </Link>
        </nav>

        <aside className="tree" data-hidden={!panels.tree}>
          <ul className="tree-view" role="tree" aria-label="项目树" aria-multiselectable={false} onKeyDown={onKeyDown}>
            {rootNode ? (
              <li {...nodeProps(rootNode)}>
                <span className="tree-row">
                  <span>{projectTree.rootLabel}</span>
                  <span className="count">{projectTree.rootNote}</span>
                </span>
                {expanded.has(rootNode.id) ? (
                  <ul role="group" className="tree-group">
                    {projectTree.groups.map((group) => {
                      const groupNode = visibleNodes.find((node) => node.id === group.id);
                      if (!groupNode) return null;
                      return (
                        <li key={group.id} {...nodeProps(groupNode)}>
                          <span className="tree-row">
                            <span>{group.label}</span>
                            <span className="count">{group.leaves.length}</span>
                          </span>
                          {expanded.has(group.id) ? (
                            <ul role="group" className="tree-group">
                              {group.leaves.map((leaf) => {
                                const leafNode = visibleNodes.find((node) => node.id === leaf.id);
                                if (!leafNode) return null;
                                return (
                                  <li key={leaf.id} {...nodeProps(leafNode)}>
                                    <Link className="tree-row tree-leaf" href={leaf.href} tabIndex={-1} title={leaf.note}>
                                      <span>{leaf.label}</span>
                                      <span className="count">{leaf.note}</span>
                                    </Link>
                                  </li>
                                );
                              })}
                            </ul>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            ) : null}
          </ul>
        </aside>

        <main className="center">
          <nav className="tabs" aria-label="分区视图">
            {tabs.map((tab) => {
              const current = tab.href === currentUrl;
              return (
                <Link
                  key={tab.href}
                  className="tab"
                  href={tab.href}
                  data-current={current}
                  aria-current={current ? 'page' : undefined}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>
          <div className="content">{children}</div>
          <section className="bottom-panel" data-expanded={panels.bottom} aria-label="任务与日志">
            <div className="bottom-head">
              <button type="button" className="btn btn-ghost" onClick={toggleBottom} aria-expanded={panels.bottom}>
                {panels.bottom ? '▾' : '▸'} 任务与日志
              </button>
              <span className="muted">当前没有运行中的任务</span>
              <span className="muted mono">run_id —</span>
            </div>
            {panels.bottom ? (
              <div className="bottom-body">
                <p className="muted">
                  任务按实际步骤、等待条件与已提交结果展示；不使用伪造递增百分比。备考生成与课堂轮次共享预算，
                  等待审核或作答时结束当前模型轮次。
                </p>
              </div>
            ) : null}
          </section>
        </main>

        <div className="rail" aria-label="右侧面板切换">
          <button type="button" data-active={panels.rightTab === 'assistant'} onClick={() => setRightTab('assistant')} title="AI 学习助手">
            助
          </button>
          <button type="button" data-active={panels.rightTab === 'source'} onClick={() => setRightTab('source')} title="来源">
            源
          </button>
          <button type="button" data-active={panels.rightTab === 'review'} onClick={() => setRightTab('review')} title="审核">
            审
          </button>
        </div>

        <aside className="right-panel" data-hidden={!panels.right} aria-label="右侧面板">
          {panels.rightTab === 'assistant' ? (
            <div className="card">
              <h2>AI 学习助手</h2>
              <p className="secondary">
                助手只提交候选与草案。已核实知识点表是教学权威源，审核入口由你操作。
              </p>
              <ul className="check-list">
                <li>
                  <span>下一步</span>
                  <span>
                    {materials.length === 0
                      ? '导入考纲或教材节选，开始整理知识清单'
                      : pendingProposals.length > 0
                        ? '核对候选引用是否支持该知识点'
                        : '建立备考计划'}
                  </span>
                </li>
                <li>
                  <span>准入</span>
                  <span>
                    {state.admission.readyKnowledge} 项可教学 / {state.admission.blockedBySource} 项被阻断
                  </span>
                </li>
              </ul>
            </div>
          ) : null}

          {panels.rightTab === 'source' ? (
            <div className="card">
              <h2>来源</h2>
              {materials.length === 0 ? (
                <p className="muted">没有材料。缺少支持原文时，相关任务停在待核范围。</p>
              ) : (
                <ul className="check-list">
                  {materials.map((material) => (
                    <li key={material.materialId}>
                      <span>{material.displayName}</span>
                      <span className="muted mono">
                        r{material.revision} · {material.segmentCount} 段
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {panels.rightTab === 'review' ? (
            <div className="card">
              <h2>待审核候选</h2>
              {pendingProposals.length === 0 ? (
                <p className="muted">没有待审核候选。</p>
              ) : (
                <ul className="check-list">
                  {pendingProposals.slice(0, 8).map((proposal) => (
                    <li key={proposal.proposalId}>
                      <span>{proposal.name}</span>
                      <span className="pill" data-tone={proposal.mechanical.passed ? 'pending' : 'error'}>
                        {proposal.mechanical.passed ? '待语义审核' : '缺少来源'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted" style={{ marginTop: 'var(--sew-space-3)' }}>
                机械通过只代表引用可定位；语义支持需要你对照原文判断。
              </p>
            </div>
          ) : null}
        </aside>
      </div>

      <footer className="shell-status">
        <span title={state.project.displayPath}>{state.project.displayPath}</span>
        <span>{draftLabel}</span>
        <span>
          学习状态：{state.counts.attemptsReal > 0 ? `本人已提交 ${state.counts.attemptsReal} 次` : '尚未开始'}
        </span>
        <span className="spacer" />
        <ModelConnectionIndicator />
      </footer>
    </div>
  );
};
