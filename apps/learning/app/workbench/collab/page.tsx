import type { ReactNode } from 'react';
import { getLearnerProfile } from '../../../lib/server/learner-profile';
import { requireSession } from '../../../lib/server/service';
import {
  CollabClassroomPanel,
  type CollabLessonOption,
} from '../../../components/collab-classroom';

export const dynamic = 'force-dynamic';

/**
 * 双人共同课堂入口（INVITE-01 / ROOM-01 / CHAT-01 的界面侧）。
 *
 * 页面只读地把「本人身份 + 可邀请的已发布课程冻结摘要」交给面板：
 * 摘要取自课程与课堂文档的既有绑定，未装配课堂文档的课程不给摘要，界面据此禁止邀请，
 * 避免用一个凭空造的指纹把人邀进一个读不出来的版本。
 */
export default function CollabPage(): ReactNode {
  const session = requireSession();
  const profile = getLearnerProfile();
  const lessons: CollabLessonOption[] = session.store
    .listLessons(session.projectId)
    .filter((lesson) => lesson.status === 'published')
    .map((lesson) => {
      const link = session.store.getLessonClassroomLink(lesson.lessonId, session.projectId);
      const digest = link && link.lessonVersion === lesson.version ? link.documentDigest : null;
      return {
        lessonId: lesson.lessonId,
        lessonVersion: lesson.version,
        title: lesson.title,
        snapshotDigest: digest,
      };
    });

  return (
    <div className="page-wide">
      <div className="page-head">
        <div>
          <h1>双人共同课堂</h1>
          <p>
            在线协作的邀请、准备与讨论入口；只有真实连接与本人认证成功后才开放在线能力，
            否则继续显示「不能联网邀请」。
          </p>
        </div>
      </div>
      <CollabClassroomPanel
        key={`${session.projectId}:${session.generation}`}
        scope={{ projectId: session.projectId, generation: session.generation }}
        selfUid={session.learnerUid}
        selfDisplayName={profile.displayName}
        lessons={lessons}
      />
    </div>
  );
}
