import type { ReactNode } from 'react';
import Link from 'next/link';
import { Empty } from '../../../components/ui';
import { bootstrapFromEnvironment, getSession } from '../../../lib/server/service';
import { readWorkbenchKnowledge } from '../../../lib/server/workbench-data';

export const dynamic = 'force-dynamic';

export default function StudyPage(): ReactNode {
  const session = (getSession() ?? bootstrapFromEnvironment())!;
  const view = readWorkbenchKnowledge(session);
  const admitted = view.rows.filter((point) => view.admittedIds.has(point.knowledgeId));
  const confirmedPlan = session.store.getConfirmedPlan<{ tasks?: unknown[] }>(session.projectId);
  const questions = session.store.listQuestions();

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>今日学习</h1>
          <p>
            本页列出准入通过的知识点与可用题目及其身份来源。讲解、例题分步、独立练习与复盘属于后续里程碑：
            教师讲解与白板（TEACH-01/BOARD-01）、互动（VIS-01/02）与订正复做（ERROR-01）尚未接入，
            这里不显示它们的进度或结果。
          </p>
        </div>
        <div className="actions">
          <Link className="btn btn-primary" href="/classroom/lesson-001">
            进入课堂
          </Link>
        </div>
      </div>

      <div className="card">
        <h2>今日步骤</h2>
        <ol className="reading" style={{ paddingLeft: '1.2em' }}>
          <li>
            计划状态：{confirmedPlan ? `已确认 v${confirmedPlan.version}` : '尚未确认计划'}
            {confirmedPlan ? '' : '（缺少已确认计划时不能生成正式课程）'}
          </li>
          <li>可准入知识点：{admitted.length} 项</li>
          <li>可用题目：{questions.length} 道（每道题始终显示原题 / 材料改写 / AI 新编标签）</li>
          <li>教师讲解与课堂推进尚未接入：本页不会自动播放，也不会替学习者推进步骤</li>
        </ol>
      </div>

      <div className="card">
        <h2>可教学知识点</h2>
        {admitted.length === 0 ? (
          <Empty>当前没有准入通过的知识点，因此不会生成课程草案。</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>知识点</th>
                <th>来源</th>
                <th>掌握状态</th>
              </tr>
            </thead>
            <tbody>
              {admitted.map((point) => (
                <tr key={point.knowledgeId}>
                  <td>{point.name}</td>
                  <td className="mono muted">
                    {point.evidence.map((item) => `${item.materialId}/${item.segmentId}`).join('、')}
                  </td>
                  <td>{point.masteryStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>题目</h2>
        {questions.length === 0 ? (
          <Empty>还没有题目。题目身份由可信创建/导入记录裁定，AI 自报「真题」不生效。</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>题干</th>
                <th>身份</th>
                <th>出处</th>
                <th>知识点</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((question) => (
                <tr key={question.questionId} id={`q-${question.questionId}`} style={{ scrollMarginTop: 'var(--sew-space-6)' }}>
                  <td>{question.stem}</td>
                  <td>
                    <span className="pill" data-tone={question.origin === 'exam_original' ? 'verified' : 'info'}>
                      {question.originLabel}
                    </span>
                  </td>
                  <td className="muted">{question.originDetail ?? '—'}</td>
                  <td className="mono muted">{question.knowledgeIds.join('、')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
