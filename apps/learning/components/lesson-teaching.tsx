'use client';

/**
 * 一节课的教学工作面（TEACH-01）：卡片登记/审核 + 课堂面板。
 *
 * 场景编号在这里由教师指定：正式课件文档（stage/scenes）生成前，课堂还没有可信的场景清单，
 * 宁可让教师显式给编号，也不从界面猜一个场景把卡片挂错地方。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { BundleStatementDto, ExplanationCardDto, LessonVersionDto } from '@sew/study-contracts';
import { ClassroomPanel } from './classroom-panel';
import { Empty } from './ui';
import { ExplanationCards } from './explanation-cards';

export const LessonTeaching = ({
  projectId,
  generation,
  lesson,
  statements,
  cards,
}: {
  projectId: string;
  generation: number;
  lesson: LessonVersionDto;
  statements: BundleStatementDto[];
  cards: ExplanationCardDto[];
}): ReactNode => {
  const knownScenes = [...new Set(cards.map((card) => card.sceneId))];
  const [sceneId, setSceneId] = useState(knownScenes[0] ?? 'scene-1');

  return (
    <div className="card">
      <h2>教学准备 · {lesson.title}</h2>
      <p className="secondary">
        当前对象是已发布版本 <span className="mono">v{lesson.version}</span> 与它的证据包
        <span className="mono"> {lesson.bundleDigest.slice(0, 12)}…</span>。
        卡片与播放都绑定这一份事实，来源失效时四处入口一起阻断。
      </p>
      <div className="row-inline">
        <div className="field" style={{ flex: '1 1 240px' }}>
          <label htmlFor={`scene-${lesson.lessonId}`}>场景编号</label>
          <input
            id={`scene-${lesson.lessonId}`}
            value={sceneId}
            onChange={(event) => setSceneId(event.target.value)}
            list={`scenes-${lesson.lessonId}`}
          />
          <datalist id={`scenes-${lesson.lessonId}`}>
            {knownScenes.map((scene) => <option key={scene} value={scene} />)}
          </datalist>
        </div>
      </div>
      {statements.length === 0 ? (
        <Empty>这个证据包没有陈述，无法给卡片挂依据。请回到上一步重新冻结证据包。</Empty>
      ) : (
        <ExplanationCards
          projectId={projectId}
          generation={generation}
          lessonId={lesson.lessonId}
          lessonVersion={lesson.version}
          sceneId={sceneId}
          statements={statements}
          cards={cards}
        />
      )}
      <ClassroomPanel
        projectId={projectId}
        generation={generation}
        lessonId={lesson.lessonId}
        sceneId={sceneId}
      />
    </div>
  );
};
