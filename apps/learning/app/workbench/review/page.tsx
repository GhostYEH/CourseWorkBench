import type { ReactNode } from 'react';
import Link from 'next/link';
import { CandidateReview } from '../../../components/candidate-review';
import { ProposalForm } from '../../../components/proposal-form';
import { Empty } from '../../../components/ui';
import { getSession } from '../../../lib/server/service';
import { readSegmentChoices, readSyllabusItems, readWorkbenchProposals } from '../../../lib/server/workbench-data';
import { toProposalDto } from '../../../lib/server/dto';

export const dynamic = 'force-dynamic';

/** 独立的用户来源审核入口；只读取现有候选，不因页面访问创建或批准知识。 */
export default function SourceReviewPage(): ReactNode {
  const session = getSession();
  if (!session) return null; // Workbench layout redirects before rendering this route.

  const proposals = readWorkbenchProposals(session).map(toProposalDto);
  const pending = proposals.filter((proposal) => proposal.status === 'pending' || proposal.status === 'needs_material');
  const reviewed = proposals.filter((proposal) => proposal.status === 'approved' || proposal.status === 'rejected');
  const syllabusItems = readSyllabusItems(session);
  // 候选可以从任一已登记材料的最新版本选取，不固定在第一条材料上。
  const segments = readSegmentChoices(session);

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>来源与知识候选审核</h1>
          <p>
            逐项对照已登记原文，确认引用是否支持知识陈述、适用条件与范围。机械检查只验证引用可定位和版本一致；
            通过操作会在复验后写入权威知识清单。访问本页或读取候选不会写入知识。
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href="/workbench/materials">查看来源材料</Link>
          <Link className="btn" href="/workbench/knowledge">查看已确认知识</Link>
        </div>
      </div>

      <div className="card">
        <h2>提出来源候选</h2>
        {segments.length > 0 ? (
          <ProposalForm projectId={session.projectId} generation={session.generation} segments={segments} />
        ) : (
          <p className="muted">请先<Link href="/workbench/materials">导入材料</Link>，再从原文提出候选。</p>
        )}
        <p className="hint">
          考纲条目在<Link href="/workbench/syllabus">考纲条目</Link>页登记；条目一经登记，「考纲内」候选必须映射到条目要素才能批准。
        </p>
      </div>

      <div className="card">
        <h2>待审核（{pending.length}）</h2>
        {pending.length === 0 ? (
          <Empty>没有待审核候选。新导入材料不会自动变成已确认知识。</Empty>
        ) : (
          pending.map((proposal) => (
            <CandidateReview
              key={proposal.proposalId}
              proposal={proposal}
              projectId={session.projectId}
              generation={session.generation}
              syllabusItems={syllabusItems}
            />
          ))
        )}
      </div>

      {reviewed.length > 0 ? (
        <div className="card">
          <h2>历史审核结论</h2>
          <table>
            <thead>
              <tr>
                <th>候选</th>
                <th>结论</th>
                <th>备注</th>
                <th>审核时间</th>
              </tr>
            </thead>
            <tbody>
              {reviewed.map((proposal) => (
                <tr key={proposal.proposalId}>
                  <td>{proposal.name}</td>
                  <td>{proposal.status === 'approved' ? '已通过' : '已拒绝'}</td>
                  <td className="secondary">{proposal.reviewNote ?? '—'}</td>
                  <td className="muted mono">{proposal.reviewedAt?.slice(0, 19).replace('T', ' ') ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
