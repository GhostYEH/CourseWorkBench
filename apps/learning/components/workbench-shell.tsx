'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type {
  KnowledgePointDto,
  MaterialDto,
  PreferencesDto,
  ProposalDto,
  QuestionListItemDto,
  WorkbenchStateDto,
} from '@sew/study-contracts';
import { applyThemeToDocument, useAppStore } from '../lib/client';
import {
  buildProjectTree,
  defaultExpandedIds,
  flattenVisible,
  moveFocus,
  navigateWithArrow,
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
  { key: 'project', label: '今日备考', glyph: '◉', href: '/workbench' },
  { key: 'materials', label: '学习材料', glyph: '▤', href: '/workbench/materials' },
  { key: 'knowledge', label: '知识梳理', glyph: '◆', href: '/workbench/knowledge' },
  { key: 'plan', label: '备考计划', glyph: '▦', href: '/workbench/plan' },
  { key: 'lesson', label: '互动课堂', glyph: '▥', href: '/workbench/lessons' },
  { key: 'study', label: '练习巩固', glyph: '✎', href: '/workbench/study' },
  { key: 'mistakes', label: '错题复习', glyph: '↻', href: '/workbench/mistakes' },
] as const;

const SECTION_TABS: Record<string, Array<{ label: string; href: string }>> = {
  project: [],
  materials: [
    { label: '导入与查看材料', href: '/workbench/materials' },
    { label: '核对知识点与原文', href: '/workbench/review' },
  ],
  knowledge: [
    { label: '知识点', href: '/workbench/knowledge' },
    { label: '整理知识点', href: '/workbench/knowledge?tab=candidates' },
    { label: '考纲覆盖', href: '/workbench/syllabus' },
    { label: '检查能否用于学习', href: '/workbench/knowledge?tab=admission' },
  ],
  plan: [{ label: '我的备考计划', href: '/workbench/plan' }],
  lesson: [
    { label: '准备课程与进入课堂', href: '/workbench/lessons' },
    { label: '我的课程库', href: '/workbench/library' },
    { label: '课程助手', href: '/workbench/pro' },
  ],
  study: [
    { label: '独立练习', href: '/workbench/study' },
    { label: '课堂与成员', href: '/workbench/rooms' },
    { label: '共同学习', href: '/workbench/collab' },
  ],
  mistakes: [{ label: '我的错题与复习', href: '/workbench/mistakes' }],
  settings: [
    { label: '备考目标与模型', href: '/workbench/settings' },
    { label: '外观与阅读', href: '/workbench/appearance' },
    { label: '导出课件', href: '/workbench/exports' },
    { label: '媒体工具', href: '/workbench/media' },
    { label: '学习评测', href: '/workbench/eval' },
    { label: '个人档案', href: '/profile' },
  ],
};

const sectionOf = (pathname: string): string => {
  const segment = pathname.split('/')[2] ?? '';
  if (['materials', 'review'].includes(segment)) return 'materials';
  if (['settings', 'appearance', 'exports', 'media', 'eval'].includes(segment)) return 'settings';
  if (segment === 'syllabus') return 'knowledge';
  if (['lessons', 'library', 'pro'].includes(segment)) return 'lesson';
  if (['rooms', 'collab'].includes(segment)) return 'study';
  if (['knowledge', 'plan', 'study', 'mistakes'].includes(segment)) return segment;
  return 'project';
};

export const WorkbenchShell = ({
  state,
  materials,
  proposals,
  questions,
  knowledge,
  preferences,
  children,
}: ShellProps) => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const panels = useAppStore((s) => s.panels);
  const toggleTree = useAppStore((s) => s.toggleTree);
  const toggleRight = useAppStore((s) => s.toggleRight);
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
    () =>
      buildProjectTree({
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
  const visibleNodes = useMemo(
    () => flattenVisible(projectTree, expanded),
    [projectTree, expanded],
  );

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

  const registerNode =
    (id: string) =>
    (element: HTMLLIElement | null): void => {
      if (element) nodeRefs.current.set(id, element);
      else nodeRefs.current.delete(id);
    };

  const nodeProps = (
    node: FlatNode,
  ): {
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
    state.counts.proposalsPending > 0
      ? `${state.counts.proposalsPending} 项知识点待核对`
      : state.counts.knowledgeVerified > 0
        ? '知识点核对完成'
        : '尚未整理知识点';

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
        </span>
        <div className="top-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={toggleTree}
            aria-pressed={panels.tree}
          >
            学习目录
          </button>
          <Link className="btn btn-ghost" href="/workbench/materials">
            导入材料
          </Link>
          <details className="study-space-menu">
            <summary className="btn btn-ghost">学习空间</summary>
            <div className="study-space-popover">
              <p className="muted">切换已有数据或为另一门科目建立独立空间。</p>
              <ProjectActions mode="manage" />
            </div>
          </details>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={toggleRight}
            aria-pressed={panels.right}
          >
            学习提示
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
          <Link
            className="activity-item"
            href="/workbench/settings"
            data-active={section === 'settings'}
          >
            <span className="activity-glyph" aria-hidden="true">
              ⚙
            </span>
            设置
          </Link>
        </nav>

        <aside className="tree" data-hidden={!panels.tree}>
          <ul
            className="tree-view"
            role="tree"
            aria-label="学习目录"
            aria-multiselectable={false}
            onKeyDown={onKeyDown}
          >
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
                                    <Link
                                      className="tree-row tree-leaf"
                                      href={leaf.href}
                                      tabIndex={-1}
                                      title={leaf.note}
                                    >
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
          {tabs.length > 0 ? (
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
          ) : null}
          <div className="content">{children}</div>
        </main>

        {panels.right ? (
          <div className="rail" aria-label="右侧面板切换">
            <button
              type="button"
              data-active={panels.rightTab === 'assistant'}
              onClick={() => setRightTab('assistant')}
              title="学习提示"
            >
              助
            </button>
            <button
              type="button"
              data-active={panels.rightTab === 'source'}
              onClick={() => setRightTab('source')}
              title="来源"
            >
              源
            </button>
            <button
              type="button"
              data-active={panels.rightTab === 'review'}
              onClick={() => setRightTab('review')}
              title="审核"
            >
              审
            </button>
          </div>
        ) : null}

        <aside className="right-panel" data-hidden={!panels.right} aria-label="右侧面板">
          {panels.rightTab === 'assistant' ? (
            <div className="card">
              <h2>学习提示</h2>
              <p className="secondary">
                从材料到知识点、计划和课程，按当前进度选择下一步。需要对话帮助时，可进入课程助手。
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
                    {state.admission.readyKnowledge} 项可教学 / {state.admission.blockedBySource}{' '}
                    项被阻断
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
                      <span
                        className="pill"
                        data-tone={proposal.mechanical.passed ? 'pending' : 'error'}
                      >
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
        <span>学习数据保存在本机</span>
        <span>{draftLabel}</span>
        <span>
          学习状态：
          {state.counts.attemptsReal > 0
            ? `本人已提交 ${state.counts.attemptsReal} 次`
            : '尚未开始'}
        </span>
        <span className="spacer" />
        <ModelConnectionIndicator />
      </footer>
    </div>
  );
};
