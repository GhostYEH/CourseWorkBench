import type { ReactNode } from 'react';
import { PlanActions } from '../../../components/plan-actions';
import { PlanTasks } from '../../../components/plan-tasks';
import { RunPanel } from '../../../components/run-panel';
import { Empty, Stat } from '../../../components/ui';
import { bootstrapFromEnvironment, getSession } from '../../../lib/server/service';
import { readWorkbenchRun } from '../../../lib/server/workbench-data';

export const dynamic = 'force-dynamic';

/**
 * 备考计划（PLAN-01）。
 *
 * 草案任务逐条人工确认，确认整版后才启动 run；未确认任务转入待核范围而不是被静默删除。
 */
export default function PlanPage(): ReactNode {
  const session = (getSession() ?? bootstrapFromEnvironment())!;
  const projectId = session.projectId;
  const latest = session.store.getLatestPlan(projectId);
  const confirmed = session.store.getConfirmedPlan(projectId);
  const snapshot = readWorkbenchRun(session);

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
          <Stat value={latest?.payload.tasks.length ?? 0} label="草案任务" />
          <Stat
            value={latest ? latest.payload.confirmedTaskKnowledgeIds.length : 0}
            label="已逐条确认任务"
          />
          <Stat value={latest?.payload.gaps.length ?? 0} label="待核范围" />
          <Stat value={snapshot ? snapshot.state : '未启动'} label="备考 run" />
        </div>
      </div>

      <PlanActions
        projectId={projectId}
        generation={session.generation}
        status={latest?.status ?? null}
        confirmedTaskCount={latest?.payload.confirmedTaskKnowledgeIds.length ?? 0}
      />

      {latest ? (
        <PlanTasks
          projectId={projectId}
          generation={session.generation}
          version={latest.version}
          status={latest.status}
          payload={latest.payload}
        />
      ) : (
        <div className="card">
          <h2>任务列表</h2>
          <Empty>还没有计划版本。完成知识点审核后点「生成计划草案」。</Empty>
        </div>
      )}

      {latest && latest.payload.gaps.length > 0 ? (
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
                <tr key={`${gap.knowledgeId}-${gap.code}`}>
                  <td>{gap.name}</td>
                  <td className="mono">{gap.code}</td>
                  <td className="mono muted">{gap.missing.join('、') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <RunPanel
        projectId={projectId}
        generation={session.generation}
        snapshot={snapshot}
        canStart={confirmed !== null && confirmed.payload.confirmedTaskKnowledgeIds.length > 0}
      />
    </div>
  );
}
