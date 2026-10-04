'use client';
import { useCommand } from '../lib/use-command';

import { apiResponses,type ClassroomRoomDto,type ClassroomSharedCourseDto } from '@sew/study-contracts';
import Link from 'next/link';
import { useRef,useState,type ReactNode } from 'react';
import { apiFetch } from '../lib/client';
import { Notice } from './ui';

export const ClassroomRooms = ({ projectId, generation, initialRooms, lessons }: {
  projectId: string; generation: number; initialRooms: ClassroomRoomDto[];
  lessons: Array<{ lessonId: string; version: number; title: string }>;
}): ReactNode => {
  const [rooms, setRooms] = useState(initialRooms);
  const [lessonId, setLessonId] = useState(lessons[0]?.lessonId ?? '');
  const [snapshot, setSnapshot] = useState<ClassroomSharedCourseDto | null>(null);
  const command = useCommand([projectId, generation].join(':'));
  const { busy, error } = command;
  const pending = useRef<{ lessonId: string; version: number; requestId: string } | null>(null);
  const readUrl = `/api/study/rooms?projectId=${encodeURIComponent(projectId)}&generation=${generation}`;
  const create = async (): Promise<void> => {
    const lesson = lessons.find(item => item.lessonId === lessonId);
    if (!lesson) return;
    await command.run(async ({ signal, commit }) => {
      if (pending.current?.lessonId !== lesson.lessonId || pending.current.version !== lesson.version) {
        pending.current = { lessonId: lesson.lessonId, version: lesson.version, requestId: crypto.randomUUID() };
      }
      await apiFetch('/api/study/rooms', apiResponses.classroomRoomWrite, { method: 'POST', signal, body: JSON.stringify({
        scope: { projectId, generation }, lessonId, lessonVersion: lesson.version, requestId: pending.current.requestId,
      }) });
      commit(() => { pending.current = null; });
      return apiFetch(readUrl, apiResponses.classroomRooms, { signal });
    }, { onSuccess: current => setRooms(current.rooms) });
  };
  const inspect = async (roomId: string): Promise<void> => {
    await command.run(({ signal }) => apiFetch(readUrl + "&roomId=" + encodeURIComponent(roomId), apiResponses.classroomRooms, { signal }), {
      onStart: () => setSnapshot(null),
      onSuccess: current => { setRooms(current.rooms); setSnapshot(current.snapshot); },
    });
  };
  return <div data-classroom-rooms>
    <Notice tone="info">当前可建立个人课堂。每个课堂保存固定的课程版本和来源；联网身份、邀请与双人交流正在开发。</Notice>
    <form className="card" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label>已发布课程<select data-room-lesson value={lessonId} disabled={busy} onChange={event => setLessonId(event.target.value)}>
        {lessons.map(lesson => <option key={lesson.lessonId} value={lesson.lessonId}>{lesson.title} · v{lesson.version}</option>)}
      </select></label>
      <button data-room-create className="btn btn-primary" disabled={busy || !lessonId}>建立个人课堂</button>
      {lessons.length === 0 ? <p>请先在课程页审核、发布并生成正式课件。</p> : null}
    </form>
    {rooms.map(room => <article key={room.roomId} data-room-id={room.roomId} className="card">
      <h2>{room.course.title} · v{room.course.lessonVersion}</h2>
      <p>{room.status === 'ended' ? '已结束' : room.status === 'active' ? '上课中' : '准备就绪'} · 本地本人 · {room.members.length} 位成员</p>
      <p className="hint mono">课程摘要：{room.snapshotDigest}</p>
      <p className="hint">课程保持本版本；来源失效或课程被撤回时停止新教学动作。</p>
      <div className="row-inline">
        {room.status !== 'ended' ? <Link data-room-enter className="btn btn-primary" href={`/classroom/${encodeURIComponent(room.course.lessonId)}?room=${encodeURIComponent(room.roomId)}`}>进入课堂</Link> : null}
        <button className="btn" disabled={busy} onClick={() => void inspect(room.roomId)}>核对课程与来源</button>
      </div>
    </article>)}
    {snapshot ? <section className="card" data-room-snapshot>
      <h2>冻结课程：{snapshot.course.title}</h2>
      <ol>{snapshot.scenes.map(scene => <li key={scene.sceneId}>
        {scene.title} · {scene.type === 'slide' ? '课件' : scene.type === 'quiz' ? '测验' : `互动（${scene.interaction.kind === 'parameter' ? '参数实验' : '概念关系'}）`}
      </li>)}</ol>
      <p>来源段落 {snapshot.evidence.segments.length} 条，课程资源 {snapshot.assets.length} 项。</p>
      {snapshot.evidence.segments.map(segment => <details key={`${segment.materialId}:${segment.revision}:${segment.segmentId}`}>
        <summary>{segment.materialId} / {segment.segmentId} @r{segment.revision}</summary><p style={{ whiteSpace: 'pre-wrap' }}>{segment.text}</p>
      </details>)}
    </section> : null}
    {error ? <Notice tone="error" role="alert">{error}</Notice> : null}
  </div>;
};
