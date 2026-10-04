import type { ReactNode } from 'react';
import { Empty,Stat } from '../../../components/ui';
import { computeBlockRate } from '../../../lib/server/eval-metrics';
import { requireSession } from '../../../lib/server/service';
import { readWorkbenchMaterials,readWorkbenchProposals } from '../../../lib/server/workbench-data';

export const dynamic = 'force-dynamic';

export default function EvalPage(): ReactNode {
  const session = requireSession();
  const knowledge = session.store.listKnowledge();
  const materials = readWorkbenchMaterials(session);
  const questions = session.store.listQuestions();
  const attemptsReal = session.store.listAttempts('real');
  const attemptsSimulation = session.store.listAttempts('simulation');
  const coverage = session.store.syllabusCoverage();

  // 分子 = 被服务端检出并降级的伪装题；分母 = 全部自报真题（requestedOrigin=exam_original）。
  const forgedExam = questions.filter((q) => q.forgedExamClaim).length;
  const examClaimed = questions.filter((q) => q.requestedOrigin === 'exam_original').length;
  const forgedExamRate = examClaimed === 0 ? null : forgedExam / examClaimed;
  // 分母 = 全部候选数；分子 = 机械检查未通过（被阻断）的候选数。两者独立。
  const proposals = readWorkbenchProposals(session);
  const blockRate = computeBlockRate(proposals.map((proposal) => ({ blocked: !proposal.mechanical.passed })));

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>指标与用例</h1>
          <p>
            每项显示分子、分母、结果和样本列表，支持打开失败案例。无来源注入使用专门「评测项目」运行，
            避免把演示记录混入用户学习数据。当前显示的是本地记录的真实计数，不是评分结果。
          </p>
        </div>
      </div>

      <div className="card">
        <h2>当前可计算的分母</h2>
        <table>
          <thead>
            <tr>
              <th>指标</th>
              <th>分子</th>
              <th>分母</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>对考纲的知识点覆盖率</td>
              <td className="mono">{coverage.coveredItems}</td>
              <td className="mono">{coverage.totalItems === 0 ? '考纲条目尚未登记' : coverage.totalItems}</td>
              <td className="muted">
                分子为必要要素全部被覆盖的条目数；部分覆盖 {coverage.partialItems} 条、未覆盖 {coverage.uncoveredItems} 条、
                已核实但未映射条目的知识点 {coverage.unmappedKnowledge} 条另报。必要前置不计入分子。
                当前覆盖率 {coverage.coverageRate === null ? 'N/A（分母未建立）' : `${Math.round(coverage.coverageRate * 100)}%`}
              </td>
            </tr>
            <tr>
              <td>来源可追溯率（机械层）</td>
              <td className="mono">{knowledge.filter((k) => k.evidence.length > 0).length}</td>
              <td className="mono">{knowledge.length}</td>
              <td className="muted">机械可定位；语义支持率需人工抽检另报</td>
            </tr>
            <tr>
              <td>无来源知识点阻断率</td>
              <td className="mono">{blockRate.numerator}</td>
              <td className="mono">{blockRate.denominator}</td>
              <td className="muted">
                分子为机械检查未通过（被阻断）的候选数，分母为全部候选数；固定注入集上应为 100%。
                当前阻断率 {blockRate.rate === null ? 'N/A（暂无候选）' : `${Math.round(blockRate.rate * 100)}%`}
              </td>
            </tr>
            <tr>
              <td>AI 新编题被误标为真题的检出率</td>
              <td className="mono">{forgedExam}</td>
              <td className="mono">{examClaimed === 0 ? 'N/A' : examClaimed}</td>
              <td className="muted">
                分子为被检出并降级的伪装题（服务端裁定），分母为全部自报真题（requestedOrigin=exam_original）。
                {forgedExamRate === null
                  ? ' 分母为 0，检出率 N/A。'
                  : ` 检出率 ${Math.round(forgedExamRate * 100)}%。`}
                正式产物中「错误真题标签」应为 0（即 origin=exam_original 且未获授权核实）。
              </td>
            </tr>
            <tr>
              <td>会话恢复（重复提交数）</td>
              <td className="mono">0</td>
              <td className="mono">{attemptsReal.length}</td>
              <td className="muted">幂等键命中即读取既有收据</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>样本</h2>
        <div className="grid-2">
          <Stat value={materials.length} label="材料版本" />
          <Stat value={questions.length} label="题目" />
          <Stat value={attemptsReal.length} label="本人作答" />
          <Stat value={attemptsSimulation.length} label="模拟作答（单独报告）" />
        </div>
      </div>

      <div className="card">
        <h2>演示与攻击用例</h2>
        <ol className="reading" style={{ paddingLeft: '1.2em' }}>
          <li>无来源候选：在「待审核」中提交无来源候选，机械检查返回 SOURCE_MISSING，权威知识点数量不变。</li>
          <li>生成准入：勾选该候选对应的知识点运行准入检查，返回 KNOWLEDGE_NOT_VERIFIED，任务不调用模型。</li>
          <li>伪装真题：提交 requestedOrigin=exam_original 且无可信记录的题目，身份被降级为 AI 新编题。</li>
          <li>模拟作答隔离：以 peer_ai 提交 kind=real，落库为 simulation，本人掌握状态不变。</li>
          <li>崩溃恢复：以同一幂等键重复提交，读取既有收据，重复数为 0。</li>
        </ol>
      </div>

      {knowledge.length === 0 ? (
        <div className="card">
          <Empty>还没有数据可供计算。先完成材料导入与知识点审核。</Empty>
        </div>
      ) : null}
    </div>
  );
}
