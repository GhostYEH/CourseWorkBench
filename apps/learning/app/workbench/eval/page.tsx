import type { ReactNode } from 'react';
import { Stat } from '../../../components/ui';
import { requireSession } from '../../../lib/server/service';
import { readWorkbenchMaterials, readWorkbenchProposals } from '../../../lib/server/workbench-data';
import { EvalReportImportPanel } from './eval-report-import-panel';

export const dynamic = 'force-dynamic';

export default function EvalPage(): ReactNode {
  const session = requireSession();
  const materials = readWorkbenchMaterials(session);
  const proposals = readWorkbenchProposals(session);
  const questions = session.store.listQuestions();
  const real = session.store.listAttempts('real');
  const simulation = session.store.listAttempts('simulation');
  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>评测与运行记录</h1>
          <p>
            核心真实评测未运行。尚无独立人工金标准、冻结测试集和可复验报告；工作区记录数量不能作为核心评测分母。
          </p>
        </div>
      </div>
      <div className="card">
        <h2>四项核心评测：未运行</h2>
        <table>
          <thead>
            <tr>
              <th>评测项</th>
              <th>冻结分母与判据</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>原子考纲覆盖</td>
              <td>完整冻结的原子要求，逐项检查获准产物覆盖；必要前置另计。</td>
              <td>未运行</td>
            </tr>
            <tr>
              <td>教学陈述来源追溯</td>
              <td>全部教学陈述逐条机械定位；语义支持需独立人工核验另报。</td>
              <td>未运行</td>
            </tr>
            <tr>
              <td>错因归因</td>
              <td>独立金标准错因集合严格匹配、固定标签宏 F1、弃答率及不可归因拒绝率。</td>
              <td>未运行</td>
            </tr>
            <tr>
              <td>题目身份</td>
              <td>已知伪装真题检出、合法真原题误拦及最终错误身份，附逐项失败和混淆矩阵。</td>
              <td>未运行</td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          真实与合成样本分开，审核前后分开。缺失输出保留在冻结分母，空分母返回
          null。恢复重复提交需要独立运行证据，当前未测。
        </p>
      </div>
      <div className="card">
        <h2>运行记录概览</h2>
        <p className="muted">仅为当前项目记录计数，不表示来源正确、模型质量或攻击检出率。</p>
        <div className="grid-2">
          <Stat value={materials.length} label="材料版本" />
          <Stat value={proposals.length} label="候选记录" />
          <Stat value={questions.length} label="题目记录" />
          <Stat value={real.length} label="本人作答" />
          <Stat value={simulation.length} label="模拟作答（单独记录）" />
        </div>
      </div>
      <EvalReportImportPanel
        key={`${session.projectId}:${session.generation}`}
        projectId={session.projectId}
        generation={session.generation}
      />
    </div>
  );
}
