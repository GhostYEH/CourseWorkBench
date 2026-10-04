import Link from 'next/link';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { Stat } from '../../components/ui';
import { bootstrapFromEnvironment, getSession } from '../../lib/server/service';
import { readWorkbenchState } from '../../lib/server/workbench-data';

export const dynamic = 'force-dynamic';

export default function WorkbenchOverview(): ReactNode {
  const session = getSession() ?? bootstrapFromEnvironment();
  if (!session) redirect('/no-project');
  const state = readWorkbenchState(session);
  const reviewTasks = session.store.listReviewTasks(session.projectId, session.learnerUid);
  const dueReviewTasks = reviewTasks.filter(task => task.status === 'confirmed' && task.dueAt <= new Date().toISOString());

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>{state.project.displayName}</h1>
          <p>
            {state.project.goal || '尚未填写学习目标。目标、考试日期与每天可用时间在「科目设置」中维护。'}
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href="/workbench/materials">
            导入材料
          </Link>
          <Link className="btn btn-primary" href="/workbench/knowledge?tab=candidates">
            审核候选
          </Link>
        </div>
      </div>

      <div className="card">
        <div className="grid-2">
          <Stat value={state.counts.materials} label="材料版本" />
          <Stat value={state.counts.knowledgeVerified} label="已核实知识点" />
          <Stat value={state.counts.proposalsPending} label="待审核候选（不计入覆盖）" />
          <Stat value={state.counts.questions} label="题目" />
          <Stat value={state.counts.attemptsReal} label="本人真实作答" />
          <Stat value={state.counts.attemptsSimulation} label="模拟作答（隔离存储）" />
        </div>
      </div>

      <div className="card">
        <h2>来源与准入</h2>
        <p className="secondary">
          正式教学与出题只能使用已核实、当前仍有效、范围合规且前置满足的知识点。来源不足只阻断受影响的任务，
          其他已核实的任务仍可执行。
        </p>
        <div className="grid-2">
          <Stat value={state.admission.readyKnowledge} label="可进入生成" />
          <Stat value={state.admission.blockedBySource} label="被来源或范围阻断" />
        </div>
        <p className="muted" style={{ marginTop: 'var(--sew-space-3)' }}>
          自检入口：
          <Link href="/workbench/knowledge?tab=admission">生成准入自检</Link>
        </p>
      </div>

      <div className="card">
        <h2>下一步</h2>
        <p><Link href="/workbench/mistakes">到期复习：{dueReviewTasks.length} 项 · 查看原作答、错因审核与复习安排</Link></p>
        <ol className="reading" style={{ margin: 0, paddingLeft: '1.2em' }}>
          {state.counts.materials === 0 ? <li>导入考纲或教材节选（支持 txt / md）。</li> : null}
          {state.counts.materials > 0 && state.counts.knowledgeVerified === 0 ? (
            <li>从材料段落提出知识点候选，并对照原文完成审核。</li>
          ) : null}
          {state.counts.proposalsPending > 0 ? <li>核对 {state.counts.proposalsPending} 项待审候选的引用是否支持该陈述。</li> : null}
          {state.plan.confirmedVersion === null ? <li>确认备考计划（需要先有可准入知识点）。</li> : null}
          {state.counts.questions === 0 && state.counts.knowledgeVerified > 0 ? (
            <li>基于已核实知识点建立题目，题目身份由程序裁定。</li>
          ) : null}
          {state.counts.knowledgeVerified > 0 ? <li>进入课堂，用已审核内容完成一节课程与独立练习。</li> : null}
        </ol>
      </div>

      <div className="card">
        <h2>当前阶段边界</h2>
        <p className="secondary">
          已实现：项目与材料版本、规范化与指纹、候选与机械检查、人工语义审核、权威知识点表、生成准入、
          题目身份裁定、作答分区与提交去重、外观与阅读设置、本地服务握手与身份边界。
        </p>
        <p className="secondary">
          待接入：OpenMAIC 课堂基线（教师、白板、二维互动）、模型连接、备考计划自动生成、错题归因、
          评测指标计算与 Windows 安装包。
        </p>
      </div>
    </div>
  );
}
