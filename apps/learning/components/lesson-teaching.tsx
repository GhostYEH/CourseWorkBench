'use client';

/**
 * 一节课的教学准备（TEACH-01）：卡片登记与审核。
 *
 * 场景编号优先取该版本已挂接课件文档里的场景；文档还没生成时由教师显式给编号，
 * 宁可让教师写清楚，也不从界面猜一个场景把卡片挂错地方。
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import type { BundleStatementDto, ExplanationCardDto, LessonVersionDto } from '@sew/study-contracts';
import { Empty, Notice } from './ui';
import { ExplanationCards } from './explanation-cards';

export const LessonTeaching = ({
  projectId,
  generation,
  lesson,
  statements,
  cards,
  sceneIds = [],
}: {
  projectId: string;
  generation: number;
  lesson: LessonVersionDto;
  statements: BundleStatementDto[];
  cards: ExplanationCardDto[];
  /** 课件文档已挂接时的场景编号；没有文档时仍由教师显式给编号。 */
  sceneIds?: string[];
}): ReactNode => {
  const knownScenes = [...new Set([...sceneIds, ...cards.map((card) => card.sceneId)])];
  const [sceneId, setSceneId] = useState(knownScenes[0] ?? 'scene-1');

  return (
    <div className="card">
      <h2>教学准备 · {lesson.title}</h2>
      <p className="secondary">
        当前对象是已发布版本 <span className="mono">v{lesson.version}</span> 与它的证据包
        <span className="mono"> {lesson.bundleDigest.slice(0, 12)}…</span>。
        卡片与播放都绑定这一份事实，来源失效时四处入口一起阻断。
      </p>
      {sceneIds.length > 0 ? (
        <Notice tone="verified">
          课件文档已挂接，本课时共 {sceneIds.length} 个场景；
          <Link href={`/classroom/${lesson.lessonId}`}>进入这一节课的课堂</Link>
        </Notice>
      ) : (
        <Notice tone="pending">
          这一版还没有挂接课件文档。在「课程与证据包」表格里执行「生成课件文档并挂接」后，
          课堂才会读取该版本的文档；卡片场景编号需与文档场景一致才能在本场景播放。
        </Notice>
      )}
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
    </div>
  );
};
