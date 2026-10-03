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
            以每题为单位显示原题、作答原貌、具体错步、错因与证据、完整订正、复做题与复做记录。
            只有答案而没有过程时，显示「依据不足，需要补充过程」并保留补过程入口。
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
                      {attempt.attributionStatus === 'proposed' ? '可提出错因候选' : '依据不足，需要补充过程'}
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
