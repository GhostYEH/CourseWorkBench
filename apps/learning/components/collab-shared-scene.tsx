import type { ReactNode } from 'react';
import type { ClassroomSharedCourseDto } from '@sew/study-contracts';

/** Both members consume the room's frozen public content and authoritative scene pointer. */
export const CollabSharedScene = ({
  snapshot,
  sceneId,
}: {
  snapshot: ClassroomSharedCourseDto | null;
  sceneId: string | null;
}): ReactNode => {
  const scene = snapshot?.scenes.find((item) => item.sceneId === sceneId);
  if (!snapshot) return <p className="hint">共享课程尚未读回，请稍后重试。</p>;
  if (!scene) return <p className="hint">等待房主选择共同课堂场景。</p>;
  return (
    <section className="card card-nested" data-collab-shared-scene={scene.sceneId}>
      <p className="hint">
        {snapshot.course.title} · v{snapshot.course.lessonVersion} · 共同进度
      </p>
      <h4>{scene.title}</h4>
      {scene.type === 'slide'
        ? scene.elements.map((element) => (
            <p key={element.elementId} style={{ whiteSpace: 'pre-wrap' }}>
              {element.text}
            </p>
          ))
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
