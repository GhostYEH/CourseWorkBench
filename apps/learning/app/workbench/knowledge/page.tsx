import type { ReactNode } from 'react';
import Link from 'next/link';
import { AdmissionChecker } from '../../../components/admission-checker';
import { CandidateReview } from '../../../components/candidate-review';
import { ProposalForm } from '../../../components/proposal-form';
import { Empty, MasteryPill, SourcePill } from '../../../components/ui';
import { bootstrapFromEnvironment, getSession } from '../../../lib/server/service';
import { readWorkbenchKnowledge, readWorkbenchMaterials, readWorkbenchProposals } from '../../../lib/server/workbench-data';
import { toProposalDto, toSegmentDto } from '../../../lib/server/dto';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ tab?: string }>;
}

export default async function KnowledgePage({ searchParams }: PageProps): Promise<ReactNode> {
  const session = (getSession() ?? bootstrapFromEnvironment())!;
  const tab = (await searchParams).tab ?? 'confirmed';
  const view = readWorkbenchKnowledge(session);
  const knowledge = view.rows;
  const proposals = readWorkbenchProposals(session).map(toProposalDto);
  const pending = proposals.filter((p) => p.status === 'pending' || p.status === 'needs_material');
  const materials = readWorkbenchMaterials(session);
  const segments = materials[0]
    ? session.store.getSegments(materials[0].materialId, materials[0].revision).map((segment) => ({
        ...toSegmentDto(segment),
        materialId: segment.materialId,
        revision: segment.revision,
      }))
    : [];

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>知识清单与候选审核</h1>
          <p>
            「已确认」与「待审核」分开显示，候选计数不算知识覆盖数。来源不足时审核通过按钮不可用，
            并显示具体缺口；机械通过只代表引用可定位。
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href="/workbench/knowledge">
            已确认（{knowledge.length}）
          </Link>
          <Link className="btn" href="/workbench/knowledge?tab=candidates">
            待审核（{pending.length}）
          </Link>
          <Link className="btn" href="/workbench/knowledge?tab=admission">
            生成准入自检
          </Link>
        </div>
      </div>

      {tab === 'candidates' ? (
        <>
          <ProposalForm projectId={session.projectId} generation={session.generation} segments={segments} />
          {pending.length === 0 ? (
            <div className="card">
              <Empty>没有待审核候选。</Empty>
            </div>
          ) : (
            pending.map((proposal) => (
              <CandidateReview
                key={proposal.proposalId}
                proposal={proposal}
                projectId={session.projectId}
                generation={session.generation}
              />
            ))
          )}
          {proposals.filter((p) => p.status === 'approved' || p.status === 'rejected').length > 0 ? (
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
                  {proposals
                    .filter((p) => p.status === 'approved' || p.status === 'rejected')
                    .map((proposal) => (
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
        </>
      ) : null}

      {tab === 'admission' ? (
        <AdmissionChecker
          projectId={session.projectId}
          generation={session.generation}
          knowledge={knowledge.map((point) => ({
            knowledgeId: point.knowledgeId,
            name: point.name,
            sourceStatus: point.sourceStatus,
            scopeStatus: point.scopeStatus,
          }))}
        />
      ) : null}

      {tab === 'confirmed' ? (
        <div className="card">
          <h2>已确认知识点（唯一权威源）</h2>
          {knowledge.length === 0 ? (
            <Empty>还没有已核实知识点。请先在「待审核」中完成候选审核。</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>名称与陈述</th>
                  <th>来源状态</th>
                  <th>范围</th>
                  <th>掌握</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {knowledge.map((point) => {
                  const admission = view.admissionFor(point.knowledgeId);
                  return (
                    <tr key={point.knowledgeId}>
                      <td className="mono">{point.knowledgeId}</td>
                      <td>
                        <strong>{point.name}</strong>
                        <div className="secondary">{point.concept}</div>
                        {point.conditions ? <div className="muted">适用条件：{point.conditions}</div> : null}
                      </td>
                      <td>
                        <SourcePill status={point.sourceStatus} />
                      </td>
                      <td className="muted">{point.scopeStatus}</td>
                      <td>
                        <MasteryPill status={point.masteryStatus} />
                      </td>
                      <td>
                        {point.evidence.map((item, index) => (
                          <div key={`${item.materialId}-${item.segmentId}-${index}`} style={{ marginBottom: 'var(--sew-space-2)' }}>
                            <Link
                              className="mono"
                              href={`/workbench/materials?materialId=${item.materialId}&segment=${item.segmentId}`}
                            >
                              {item.materialId} r{item.revision} · {item.segmentId}
                            </Link>
                            <div className="muted">{admission.allowed ? '准入通过' : admission.blocked[0]?.message}</div>
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </div>
  );
}
