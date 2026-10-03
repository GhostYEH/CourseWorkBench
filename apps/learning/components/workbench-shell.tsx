'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, type ReactNode } from 'react';
import type { KnowledgePointDto, MaterialDto, PreferencesDto, ProposalDto, WorkbenchStateDto } from '@sew/study-contracts';
import { applyThemeToDocument, useAppStore } from '../lib/client';
import { ProjectActions } from './project-actions';

interface ShellProps {
  state: WorkbenchStateDto;
  materials: MaterialDto[];
  proposals: ProposalDto[];
  knowledge: Array<KnowledgePointDto & { admission: { allowed: boolean } }>;
  preferences: PreferencesDto;
  children: ReactNode;
}

const NAV = [
  { key: 'project', label: '项目', glyph: '▤', href: '/workbench' },
  { key: 'knowledge', label: '知识', glyph: '◆', href: '/workbench/knowledge' },
  { key: 'review', label: '来源审核', glyph: '✓', href: '/workbench/review' },
  { key: 'plan', label: '计划', glyph: '▦', href: '/workbench/plan' },
  { key: 'study', label: '学习', glyph: '✎', href: '/workbench/study' },
  { key: 'mistakes', label: '错题', glyph: '✗', href: '/workbench/mistakes' },
  { key: 'eval', label: '评测', glyph: '◎', href: '/workbench/eval' },
] as const;

const SECTION_TABS: Record<string, Array<{ label: string; href: string }>> = {
  project: [
    { label: '总览', href: '/workbench' },
    { label: '材料与来源', href: '/workbench/materials' },
    { label: '科目设置', href: '/workbench/settings' },
    { label: '外观与阅读', href: '/workbench/appearance' },
  ],
  knowledge: [
    { label: '已确认知识', href: '/workbench/knowledge' },
    { label: '生成准入自检', href: '/workbench/knowledge?tab=admission' },
  ],
  review: [
    { label: '独立来源审核', href: '/workbench/review' },
    { label: '材料与来源', href: '/workbench/materials' },
  ],
  plan: [{ label: '备考计划', href: '/workbench/plan' }],
  study: [
    { label: '今日学习', href: '/workbench/study' },
    { label: '课堂', href: '/classroom/lesson-001' },
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
  if (['knowledge', 'review', 'plan', 'study', 'mistakes', 'eval'].includes(segment)) return segment;
  return 'project';
};

export const WorkbenchShell = ({ state, materials, proposals, knowledge, preferences, children }: ShellProps) => {
  const pathname = usePathname();
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

  const blocked = knowledge.filter((k) => !k.admission.allowed);

  const tree = useMemo(() => {
    switch (section) {
      case 'knowledge':
        return [
          { label: '已核实知识点', count: knowledge.filter((k) => k.sourceStatus === 'verified').length, href: '/workbench/knowledge' },
          { label: '独立来源审核', count: pendingProposals.length, href: '/workbench/review' },
          { label: '来源材料', count: materials.length, href: '/workbench/materials' },
          { label: '准入被阻断', count: blocked.length, href: '/workbench/knowledge?tab=admission' },
        ];
      case 'review':
        return [
          { label: '待语义审核', count: pendingProposals.length, href: '/workbench/review' },
          { label: '来源材料', count: materials.length, href: '/workbench/materials' },
          { label: '已确认知识', count: knowledge.filter((k) => k.sourceStatus === 'verified').length, href: '/workbench/knowledge' },
        ];
      case 'plan':
        return [
          { label: '已确认计划版本', count: state.plan.confirmedVersion ?? 0, href: '/workbench/plan' },
          { label: '计划任务', count: state.plan.taskCount, href: '/workbench/plan' },
          { label: '待核范围', count: blocked.length, href: '/workbench/knowledge?tab=admission' },
        ];
      case 'study':
        return [
          { label: '今日学习', count: state.counts.knowledgeVerified, href: '/workbench/study' },
          { label: '进入课堂', count: 0, href: '/classroom/lesson-001' },
        ];
      case 'mistakes':
        return [
          { label: '本人作答', count: state.counts.attemptsReal, href: '/workbench/mistakes' },
          { label: '模拟作答（不计掌握）', count: state.counts.attemptsSimulation, href: '/workbench/mistakes?tab=simulation' },
        ];
      case 'eval':
        return [
          { label: '评测用例', count: 0, href: '/workbench/eval' },
          { label: '无来源注入演示', count: 0, href: '/workbench/eval' },
        ];
      default:
        return [
          { label: '材料与来源', count: materials.length, href: '/workbench/materials' },
          { label: '已核实知识点', count: state.counts.knowledgeVerified, href: '/workbench/knowledge' },
          { label: '独立来源审核', count: pendingProposals.length, href: '/workbench/review' },
          { label: '科目设置', count: 0, href: '/workbench/settings' },
          { label: '外观与阅读', count: 0, href: '/workbench/appearance' },
        ];
    }
  }, [section, knowledge, pendingProposals.length, materials.length, blocked.length, state]);

  const tabs = SECTION_TABS[section] ?? [];

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

        <aside className="tree" data-hidden={!panels.tree} aria-label="项目树">
          <div className="tree-section">{state.project.subject || '未设置科目'}</div>
          {tree.map((row) => (
            <Link key={row.href + row.label} className="tree-row" href={row.href}>
              <span>{row.label}</span>
              <span className="count">{row.count}</span>
            </Link>
          ))}
          <div className="tree-section">材料</div>
          {materials.length === 0 ? (
            <div className="tree-row muted">尚未导入材料</div>
          ) : (
            materials.slice(0, 8).map((material) => (
              <Link key={material.materialId} className="tree-row" href="/workbench/materials">
                <span title={material.displayName}>{material.displayName}</span>
                <span className="count">r{material.revision}</span>
              </Link>
            ))
          )}
        </aside>

        <main className="center">
          <div className="tabs" role="tablist">
            {tabs.map((tab) => (
              <Link key={tab.href} className="tab" href={tab.href} data-current={false}>
                {tab.label}
              </Link>
            ))}
          </div>
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
        <span>模型连接：未配置</span>
      </footer>
    </div>
  );
};
