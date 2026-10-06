/**
 * 协作房间的读取访问守卫（ROOM-01 / SYNC-01 / CHAT-01）。
 *
 * 写入侧已按会话绑定身份（请求体自报他人 UID 即拒绝）；**读取侧同样不能**
 * 「知道 roomId 就能读」：房间一旦存在，只有它的成员能读房间状态、成员、
 * 消息与事件，否则等于把另一端的内容公开给任意本机会话。
 *
 * 房间尚未建立（只在邀请阶段、对方还没接受）时没有可泄露的内容，
 * 这里放行，由调用方返回空结果；这与「房间存在但不是成员」必须区分开。
 */

import { StudyError } from '@sew/study-contracts';
import type { Session } from './service';
import { scopedRequest } from './scoped-request';

/** 本机协作数据属于当前项目；旧页面的请求不能作用到切换后的新项目。 */
export const requireCollabSession = (request: Request): Session =>
  scopedRequest(
    request,
    () =>
      new StudyError('INVALID_ARGUMENT', {
        reason: 'collab_project_scope_required',
      }),
  ).session;

export const assertCollabRoomMember = (session: Session, roomId: string): void => {
  if (!session.store.getCollaborationRoom(roomId)) return;
  const isMember = session.store
    .listCollaborationMembers(roomId)
    .some((member) => member.uid === session.learnerUid && member.readiness !== 'left');
  if (!isMember) {
    throw new StudyError('ROLE_PERMISSION_DENIED', { reason: 'not_room_member' });
  }
};
