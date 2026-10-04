'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ClassroomSessionDto } from '@sew/study-contracts';
import { ClassroomPanel } from './classroom-panel';

/** 项目只有一个课堂面板；课时与目标场景由教师明确选择。 */
export const TeachingClassroom = ({ projectId, generation, lessons, activeSession }: {
  projectId: string;
  generation: number;
  lessons: Array<{ lessonId: string; version: number; title: string; sceneIds: string[]; stageId: string | null }>;
  activeSession: ClassroomSessionDto | null;
}): ReactNode => {
  const initial = lessons.find((lesson) => lesson.lessonId === activeSession?.lessonId
    && lesson.version === activeSession.lessonVersion) ?? lessons[0];
  const [lessonKey, setLessonKey] = useState(initial ? `${initial.lessonId}:v${initial.version}` : '');
  const [sceneId, setSceneId] = useState(activeSession?.currentSceneId ?? initial?.sceneIds[0] ?? 'scene-1');
  const selected = lessons.find((lesson) => `${lesson.lessonId}:v${lesson.version}` === lessonKey);
  if (!selected) return null;

  return (
    <div className="card">
      <h2>授课课时与场景</h2>
      <div className="row-inline">
        <div className="field">
          <label htmlFor="classroom-lesson">授课课时</label>
          <select
            id="classroom-lesson"
            value={lessonKey}
            disabled={activeSession !== null}
            onChange={(event) => {
              setLessonKey(event.target.value);
              const lesson = lessons.find((item) => `${item.lessonId}:v${item.version}` === event.target.value);
              setSceneId(lesson?.sceneIds[0] ?? 'scene-1');
            }}
          >
            {lessons.map((lesson) => (
              <option key={`${lesson.lessonId}:v${lesson.version}`} value={`${lesson.lessonId}:v${lesson.version}`}>
                {lesson.title} · v{lesson.version}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="classroom-scene">课堂目标场景</label>
          <input id="classroom-scene" value={sceneId} maxLength={120}
            onChange={(event) => setSceneId(event.target.value)} list="classroom-scenes" />
          <datalist id="classroom-scenes">
            {selected.sceneIds.map((scene) => <option key={scene} value={scene} />)}
          </datalist>
        </div>
      </div>
      <ClassroomPanel key={lessonKey} projectId={projectId} generation={generation}
        lessonId={selected.lessonId} lessonVersion={selected.version}
        stageId={selected.stageId} sceneId={sceneId} />
    </div>
  );
};
