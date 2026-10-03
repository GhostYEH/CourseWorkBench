import type { ReactNode } from 'react';
import { PlanActions } from '../../../components/plan-actions';
import { Empty, Stat } from '../../../components/ui';
import { bootstrapFromEnvironment, getSession } from '../../../lib/server/service';

export const dynamic = 'force-dynamic';

interface PlanPayload {
  goal: string;
  examDate: string | null;
  dailyMinutes: number;
  tasks: Array<{ knowledgeId: string; name: string; minutes: number; acceptance: string; evidence: Array<{ materialId: string; segmentId: string }> }>;
  gaps: Array<{ knowledgeId: string; name: string; code: string; missing: string[] }>;
  basis: string;
}

export default function PlanPage(): ReactNode {
  const session = (getSession() ?? bootstrapFromEnvironment())!;
  const latest = session.store.getLatestPlan<PlanPayload>(session.projectId);
  const confirmed = session.store.getConfirmedPlan<PlanPayload>(session.projectId);

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>备考计划</h1>
          <p>
            计划作为独立产物，通过知识点编号引用清单。每项明确知识点、用时与验收方式；
            缺材料的项位于待核范围，不能显示「开始学习」。
          </p>
        </div>
      </div>

      <div className="card">
        <div className="grid-2">
          <Stat value={confirmed ? `v${confirmed.version}` : '未确认'} label="已确认计划版本" />
          <Stat value={latest ? `v${latest.version} · ${latest.status === 'confirmed' ? '已确认' : '草案'}` : '—'} label="最近一版" />
          <Stat value={latest?.payload?.tasks?.length ?? 0} label="正式任务" />
          <Stat value={latest?.payload?.gaps?.length ?? 0} label="待核范围" />
        </div>
      </div>

      <PlanActions projectId={session.projectId} generation={session.generation} />

      {latest ? (
        <>
          <div className="card">
            <h2>任务列表</h2>
            <p className="secondary">{latest.payload.basis}</p>
            {latest.payload.tasks.length === 0 ? (
              <Empty>没有可下发的正式任务。请先完成材料导入与知识点审核。</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>知识点</th>
                    <th>预计用时</th>
                    <th>验收方式</th>
                    <th>来源</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.payload.tasks.map((task) => (
                    <tr key={task.knowledgeId}>
                      <td>{task.name}</td>
                      <td className="mono">{task.minutes} 分钟</td>
                      <td>{task.acceptance}</td>
                      <td className="mono muted">
                        {task.evidence.map((item) => `${item.materialId}/${item.segmentId}`).join('、')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {latest.payload.gaps.length > 0 ? (
            <div className="card">
              <h2>材料缺口与待核范围</h2>
              <p className="secondary">这些项不能作为已确定的教学任务下发。</p>
              <table>
                <thead>
                  <tr>
                    <th>知识点</th>
                    <th>阻断原因</th>
                    <th>缺少材料</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.payload.gaps.map((gap) => (
                    <tr key={gap.knowledgeId}>
                      <td>{gap.name}</td>
                      <td className="mono">{gap.code}</td>
                      <td className="mono muted">{gap.missing.join('、') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
