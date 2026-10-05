'use client';
import type { QuizContent } from '@openmaic/dsl';
import type { ProjectScope } from '@sew/study-contracts';
import { useQuizAttemptSession } from '../../lib/use-quiz-attempt-session';
import { writeMultipleAnswer, quizResultFeedback } from '../../lib/quiz-answer';

/** View for the source-bound quiz attempt; session persistence lives in its hook. */
export function QuizSceneView({
  content,
  sceneId,
  stageId,
  scope,
  questionId,
  reviewedBy,
}: {
  content: QuizContent;
  sceneId: string;
  stageId: string;
  scope: ProjectScope;
  questionId?: string;
  reviewedBy?: string;
}) {
  const {
    question,
    dslQuestionId,
    questionType,
    runtime,
    answer,
    setAnswer,
    processText,
    setProcessText,
    loading,
    recoveryFailed,
    busy,
    error,
    feedback,
    gradingContext,
    gradingReadError,
    selectedOptions,
    hasAnswer,
    submit,
    retry,
  } = useQuizAttemptSession({ content, sceneId, stageId, scope, questionId });
  if (!question)
    return (
      <div className="card" data-scene="quiz">
        当前测验场景没有题目。
      </div>
    );
  if (loading)
    return (
      <div className="card" data-scene="quiz" role="status">
        正在读取本人测验运行记录…
      </div>
    );

  const completed = runtime?.session.status === 'completed';
  const submitted =
    completed || runtime?.payload?.phase === 'submitted' || runtime?.payload?.phase === 'reviewed';
  return (
    <div
      className="card"
      data-scene="quiz"
      data-scene-id={sceneId}
      data-question-id={dslQuestionId}
    >
      <h2>测验：{question.question}</h2>
      {reviewedBy ? <p className="muted">来源审核：{reviewedBy}</p> : null}
      {questionType === 'short_answer' ? (
        <div className="field">
          <label htmlFor={`answer-${dslQuestionId}`}>本人作答</label>
          <textarea
            id={`answer-${dslQuestionId}`}
            data-short-answer
            value={answer}
            disabled={submitted || busy || recoveryFailed}
            onChange={(event) => setAnswer(event.target.value)}
          />
        </div>
      ) : (
        (question.options ?? []).map((option) => (
          <label key={option.value} className="check-list" style={{ display: 'block' }}>
            <input
              type={questionType === 'multiple' ? 'checkbox' : 'radio'}
              name={`q-${dslQuestionId}`}
              value={option.value}
              data-answer-option={option.value}
              checked={
                questionType === 'multiple'
                  ? selectedOptions.includes(option.value)
                  : answer === option.value
              }
              disabled={submitted || busy || recoveryFailed}
              onChange={(event) =>
                setAnswer(
                  questionType === 'multiple'
                    ? writeMultipleAnswer(
                        event.target.checked
                          ? [...selectedOptions, option.value]
                          : selectedOptions.filter((value) => value !== option.value),
                      )
                    : option.value,
                )
              }
            />
            <span>{option.label}</span>
          </label>
        ))
      )}
      <div className="field">
        <label htmlFor={`process-${dslQuestionId}`}>解题过程</label>
        <textarea
          id={`process-${dslQuestionId}`}
          value={processText}
          disabled={submitted || busy || recoveryFailed}
          onChange={(event) => setProcessText(event.target.value)}
        />
      </div>
      {completed ? (
        <>
          <p className="muted" data-attempt-result>
            {gradingContext
              ? `${quizResultFeedback(gradingContext.effectiveGrading)}${gradingContext.currentReviewVersion > 0 ? `人工评分 v${gradingContext.currentReviewVersion}。` : ''}`
              : (feedback ?? '已从本地服务读回审核记录。')}
          </p>
          {gradingContext ? (
            <details data-grading-reference>
              <summary>核对参考答案与评分依据</summary>
              <p>参考答案：{gradingContext.referenceAnswer}</p>
              <p>解析：{gradingContext.solution || '未登记解析。'}</p>
              <p>评分标准：{gradingContext.rubric}</p>
              {gradingContext.currentReviewVersion > 0 ? (
                <>
                  <p>评分依据：{gradingContext.reviews.at(-1)?.basis}</p>
                  <p>不确定性：{gradingContext.reviews.at(-1)?.uncertainty}</p>
                </>
              ) : null}
              <a href={`/workbench/mistakes#attempt-${gradingContext.attemptId}`}>
                前往错题本核对评分
              </a>
            </details>
          ) : null}
          {gradingReadError ? (
            <p role="alert" className="error-text">
              当前评分历史读取失败：{gradingReadError} 请到错题本重新读取。
            </p>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={busy || loading}
            onClick={() => void retry()}
          >
            开始一次新的测验
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          data-attempt-submit
          disabled={busy || !runtime || !questionId || !hasAnswer}
          onClick={() => void submit()}
        >
          {busy ? '正在由服务核验并保存…' : '提交给服务判分'}
        </button>
      )}
      <p className="muted">
        草稿会自动保存，提交后可重新打开查看答案与解题过程。正式本人作答按已核验结果更新掌握；简答先待判分，人工核对后保存评分版本，演示测验不计入正式进度。
      </p>
      {error ? (
        <p role="alert" className="error-text">
          {error}
        </p>
      ) : null}
      {recoveryFailed ? (
        <button type="button" className="btn" disabled={busy} onClick={() => void retry()}>
          开始一次新的测验
        </button>
      ) : null}
      {feedback && !completed ? (
        <p className="muted" data-attempt-result>
          {feedback}
        </p>
      ) : null}
    </div>
  );
}
