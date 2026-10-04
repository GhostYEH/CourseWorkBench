import type { ReactNode } from 'react';
import Link from 'next/link';
import { Empty } from '../../../components/ui';
import { SyllabusItemForm } from '../../../components/syllabus-item-form';
import { assertScope, getSession, bootstrapFromEnvironment } from '../../../lib/server/service';
import { readSegmentChoices, readSyllabusItems } from '../../../lib/server/workbench-data';

export const dynamic = 'force-dynamic';

const STATE_LABEL = {
  covered: '已完整覆盖',
  partial: '部分覆盖',
  uncovered: '未覆盖',
} as const;

/**
 * 考纲条目与覆盖（《规划书》8.1）。
 *
 * 页面只读取现有条目与统计，不因访问写入事实；覆盖率分母是登记的条目数，
 * 未登记条目时明确显示为「分母未建立」而不是 0%。
 */
export default function SyllabusPage(): ReactNode {
  const session = getSession() ?? bootstrapFromEnvironment();
  if (!session) return null; // Workbench layout redirects before rendering this route.
  assertScope({ projectId: session.projectId, generation: session.generation });

  const items = readSyllabusItems(session);
  const coverage = session.store.syllabusCoverage();
  const segments = readSegmentChoices(session);
  const coveredByItem = new Map(coverage.items.map((entry) => [entry.itemId, entry]));

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>考纲条目与覆盖</h1>
          <p>
            覆盖率 = 必要要素全部被覆盖的条目数 / 已登记条目数。多个知识点映射到同一要素只计一次；
            「必要前置」与未通过准入的知识点不增加分子。材料缺失的条目仍留在分母里，作为缺口单独报告。
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href="/workbench/review">回到候选审核</Link>
          <Link className="btn" href="/workbench/materials">查看来源材料</Link>
        </div>
      </div>

      <div className="card">
        <h2>覆盖概览</h2>
        <div className="grid-2">
          <p className="stat">
            <span className="value">
              {coverage.coverageRate === null ? '分母未建立' : `${Math.round(coverage.coverageRate * 100)}%`}
            </span>
            <span className="label">考纲覆盖率（{coverage.coveredItems}/{coverage.totalItems} 条目完整覆盖）</span>
          </p>
          <p className="stat">
            <span className="value">{coverage.partialItems}</span>
            <span className="label">部分覆盖条目</span>
          </p>
          <p className="stat">
            <span className="value">{coverage.uncoveredItems}</span>
            <span className="label">未覆盖条目</span>
          </p>
          <p className="stat">
            <span className="value">{coverage.unmappedKnowledge}</span>
            <span className="label">已核实但未映射条目的「考纲内」知识点</span>
          </p>
        </div>
        {coverage.coverageRate === null ? (
          <Empty>还没有登记考纲条目，覆盖率没有分母。先在下方把考纲拆成原子条目。</Empty>
        ) : null}
      </div>

      <SyllabusItemForm projectId={session.projectId} generation={session.generation} segments={segments} />

      <div className="card">
        <h2>已登记条目（{items.length}）</h2>
        {items.length === 0 ? (
          <Empty>没有条目。</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>考纲编号</th>
                <th>条目内容</th>
                <th>必要要素</th>
                <th>覆盖</th>
                <th>考纲原文</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const entry = coveredByItem.get(item.itemId);
                return (
                  <tr key={item.itemId}>
                    <td className="mono">{item.code}</td>
                    <td>{item.label}</td>
                    <td>
                      <ul className="secondary" style={{ margin: 0, paddingLeft: '1.2em' }}>
                        {item.requirements.map((requirement) => (
                          <li key={requirement.key}>
                            <span className="mono">{requirement.key}</span> · {requirement.text}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <span
                        className="pill"
                        data-tone={entry?.state === 'covered' ? 'verified' : entry?.state === 'partial' ? 'pending' : 'error'}
                      >
                        {entry ? STATE_LABEL[entry.state] : '未统计'} · {entry?.coveredRequirements ?? 0}/{entry?.totalRequirements ?? item.requirements.length}
                      </span>
                    </td>
                    <td className="muted">
                      <Link
                        href={`/workbench/materials?materialId=${item.source.materialId}&revision=${item.source.revision}&segment=${item.source.segmentId}#${item.source.segmentId}`}
                      >
                        r{item.source.revision} · {item.source.segmentId}
                      </Link>
                      {item.source.sourceStale ? (
                        <p className="secondary">材料已有更新版本，该条目仍指向旧版本，需要重新核对。</p>
                      ) : null}
                      <p className="excerpt">{item.source.excerpt}</p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
