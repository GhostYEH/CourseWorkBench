import type { ReactNode } from 'react';
import { Empty } from '../../../components/ui';
import { bootstrapFromEnvironment, getSession } from '../../../lib/server/service';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ tab?: string }>;
}

export default async function MistakesPage({ searchParams }: PageProps): Promise<ReactNode> {
  const session = (getSession() ?? bootstrapFromEnvironment())!;
  const tab = (await searchParams).tab === 'simulation' ? 'simulation' : 'real';
  const attempts = session.store.listAttempts(tab);
  const questions = new Map(session.store.listQuestions().map((q) => [q.questionId, q]));

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>错题本</h1>
          <p>
            本页按题显示已保存的作答原貌、过程文字与归因状态，并区分本人作答与模拟数据。
            具体错步分析、错因证据、订正与复做记录属于后续里程碑（ERROR-01），尚未接入；
            因此这里显示的是「依据不足，需要补充过程」这类状态，而不是已确认的错因结论。
          </p>
        </div>
      </div>

      <div className="card">
        <h2>{tab === 'real' ? '本人真实作答' : '模拟数据（不进入掌握统计）'}</h2>
        {attempts.length === 0 ? (
          <Empty>还没有{tab === 'real' ? '真实' : '模拟'}作答记录。</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>题目</th>
                <th>作答</th>
                <th>过程</th>
                <th>归因状态</th>
                <th>掌握影响</th>
                <th>提交时间</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => (
                <tr key={attempt.attemptId}>
                  <td>{questions.get(attempt.questionId)?.stem ?? attempt.questionId}</td>
                  <td>{attempt.answerText || '（未作答）'}</td>
                  <td className="secondary">{attempt.processText || '（缺少过程）'}</td>
                  <td>
                    <span className="pill" data-tone={attempt.attributionStatus === 'proposed' ? 'info' : 'pending'}>
                      {attempt.attributionStatus === 'proposed' ? '过程已保存，等待错因核对' : '依据不足，需要补充过程'}
                    </span>
                  </td>
                  <td className="muted">{attempt.masteryAfter ?? '不影响本人掌握'}</td>
                  <td className="muted mono">{attempt.submittedAt.slice(0, 19).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>数据分区约定</h2>
        <p className="secondary">
          AI 同学的作答保存在 simulation 分区，不写入本人 attempt、错题正确率、考纲掌握率或复习完成数。
          模拟数据可以参与软件评测，不能更新实际掌握状态。
        </p>
      </div>
    </div>
  );
}
