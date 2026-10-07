import type { ReactNode } from 'react';
import type { ClassroomSharedCourseDto, CollabTeachingStateDto } from '@sew/study-contracts';

/** Both members consume the room's frozen public content and authoritative scene pointer. */
export const CollabSharedScene = ({
  snapshot,
  sceneId,
  teaching = null,
}: {
  snapshot: ClassroomSharedCourseDto | null;
  sceneId: string | null;
  teaching?: CollabTeachingStateDto | null;
}): ReactNode => {
  const scene = snapshot?.scenes.find((item) => item.sceneId === sceneId);
  const sceneTeaching = teaching?.sceneId === sceneId ? teaching : null;
  const boardContents = sceneTeaching?.board.contents ?? [];
  if (!snapshot) return <p className="hint">共享课程尚未读回，请稍后重试。</p>;
  if (!scene) return <p className="hint">等待房主选择共同课堂场景。</p>;
  return (
    <section className="card card-nested" data-collab-shared-scene={scene.sceneId}>
      <p className="hint">
        {snapshot.course.title} · v{snapshot.course.lessonVersion} · 共同进度
      </p>
      <h4>{scene.title}</h4>
      {boardContents.length > 0 ? (
        <div data-collab-shared-board>
          <p className="hint">教师公共白板</p>
          <ul>
            {boardContents.map((item) => (
              <li key={item.eventId} data-collab-shared-board-content={item.eventId}>
                {item.content.kind === 'text' ? (
                  <span style={{ whiteSpace: 'pre-wrap' }}>{item.content.text}</span>
                ) : item.content.kind === 'formula' ? (
                  <span style={{ whiteSpace: 'pre-wrap' }}>
                    {item.content.text}
                    {item.content.latex ? (
                      <span className="mono"> · {item.content.latex}</span>
                    ) : null}
                  </span>
                ) : (
                  <span>
                    简图：{item.content.nodes.map((node) => node.label).join('、')}（
                    {item.content.edges.length} 条连线）
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {scene.type === 'slide'
        ? scene.elements.map((element) => {
            const focused = sceneTeaching?.board.focusElementId === element.elementId;
            const lasered = sceneTeaching?.board.laserElementId === element.elementId;
            return (
              <p
                key={element.elementId}
                data-collab-element={element.elementId}
                data-collab-focus={focused || undefined}
                data-collab-laser={lasered || undefined}
                style={{
                  whiteSpace: 'pre-wrap',
                  outline: focused ? '2px solid currentColor' : undefined,
                  background: lasered ? 'rgba(255, 220, 0, 0.24)' : undefined,
                }}
              >
                {focused ? <strong>教师聚焦 · </strong> : null}
                {lasered ? <strong>激光指示 · </strong> : null}
                {element.text}
              </p>
            );
          })
        : null}
      {scene.type === 'quiz' ? (
        <>
          <p className="hint">共同查看题目；个人答案与评分保留在各自的个人课堂。</p>
          {scene.questions.map((question) => (
            <div key={question.questionId}>
              <p style={{ whiteSpace: 'pre-wrap' }}>{question.stem}</p>
              <ul>
                {question.options.map((option) => (
                  <li key={option.value}>{option.label}</li>
                ))}
              </ul>
            </div>
          ))}
        </>
      ) : null}
      {scene.type === 'interactive' ? (
        <>
          <p className="hint">共同查看互动材料；个人操作与观察保留在各自的个人课堂。</p>
          {scene.interaction.kind === 'parameter' ? (
            <p>
              {scene.interaction.formula === 'linear' ? '线性函数' : '二次函数'}：参数范围{' '}
              {scene.interaction.min} ～ {scene.interaction.max}，步长 {scene.interaction.step}
              ，截距 {scene.interaction.intercept}。
            </p>
          ) : scene.interaction.kind === 'ordering' ? (
            <ul>
              {scene.interaction.items.map((item) => (
                <li key={item.id}>{item.label}</li>
              ))}
            </ul>
          ) : (
            <>
              <ul>
                {scene.interaction.nodes.map((node) => (
                  <li key={node.id}>{node.label}</li>
                ))}
              </ul>
              <ul>
                {scene.interaction.edges.map((edge) => (
                  <li key={edge.id}>{edge.label}</li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : null}
    </section>
  );
};
