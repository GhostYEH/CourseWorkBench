import type { ReactNode } from 'react';
import { ClassroomRooms } from '../../../components/classroom-rooms';
import { requireSession } from '../../../lib/server/service';

export const dynamic = 'force-dynamic';
export default function RoomsPage(): ReactNode {
  const session = requireSession();
  const lessons = session.store.listLessons(session.projectId).filter(lesson => lesson.status === 'published')
    .map(lesson => ({ lessonId: lesson.lessonId, version: lesson.version, title: lesson.title }));
  return <div className="page-wide"><div className="page-head"><div><h1>课堂与成员</h1>
    <p>选择已审核发布的课程，建立保持课程版本的个人课堂。</p></div></div>
    <ClassroomRooms projectId={session.projectId} generation={session.generation} lessons={lessons}
      initialRooms={session.store.listLocalClassroomRooms(session.projectId, session.learnerUid)} />
  </div>;
}
