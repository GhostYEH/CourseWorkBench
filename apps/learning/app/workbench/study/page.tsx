import Link from 'next/link';
import type { ReactNode } from 'react';
import { Fragment } from 'react';
import { PersonalPractice } from '../../../components/personal-practice';
import { Empty } from '../../../components/ui';
import { FIXED_LESSON_ID } from '../../../lib/classroom/reviewed-lesson';
import { requireSession } from '../../../lib/server/service';
import { readWorkbenchKnowledge } from '../../../lib/server/workbench-data';

export const dynamic = 'force-dynamic';

export default function StudyPage(): ReactNode {
  const session = requireSession();
  const view = readWorkbenchKnowledge(session);
  const admitted = view.rows.filter((point) => view.admittedIds.has(point.knowledgeId));
  const confirmedPlan = session.store.getConfirmedPlan(session.projectId);
  const questions = session.store.listQuestions();

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>练习巩固</h1>
          <p>
            选择题目独立作答，提交后查看反馈。想先听讲解，可以进入互动课堂；
            演示课使用独立示例内容，不计入你的备考进度。
          </p>
        </div>
        <div className="actions">
          <Link className="btn btn-primary" href="/workbench/lessons">
            进入互动课堂
          </Link>
          <Link className="btn" href={`/classroom/${FIXED_LESSON_ID}`}>
            固定课堂演示
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
          <li>在课程页审核讲解卡并操作会话；本页不自动播放或替学习者推进步骤</li>
        </ol>
      </div>

      <div className="card">
        <h2>已准备好的知识点</h2>
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
                    {point.evidence
                      .map((item) => `${item.materialId}/${item.segmentId}`)
                      .join('、')}
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
                <Fragment key={question.questionId}>
                  <tr
                    key={question.questionId}
                    id={`q-${question.questionId}`}
                    style={{ scrollMarginTop: 'var(--sew-space-6)' }}
                  >
                    <td>{question.stem}</td>
                    <td>
                      <span
                        className="pill"
                        data-tone={question.origin === 'exam_original' ? 'verified' : 'info'}
                      >
                        {question.originLabel}
                      </span>
                    </td>
                    <td className="muted">{question.originDetail ?? '—'}</td>
                    <td className="mono muted">{question.knowledgeIds.join('、')}</td>
                  </tr>
                  <tr>
                    <td colSpan={4}>
                      <PersonalPractice
                        key={`${session.projectId}:${session.generation}:${question.questionId}`}
                        projectId={session.projectId}
                        generation={session.generation}
                        questionId={question.questionId}
                        assessment={
                          question.assessment
                            ? {
                                type: question.assessment.type,
                                options: question.assessment.options,
                                maxScore: question.assessment.maxScore,
                                answerVersion: question.assessment.answerVersion,
                              }
                            : null
                        }
                      />
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
