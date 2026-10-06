import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { StudyError, type LearnerProfileDto } from '@sew/study-contracts';
import { LearnerProfile } from '../apps/learning/components/learner-profile';
import ProfilePage from '../apps/learning/app/profile/page';
import NoProjectPage from '../apps/learning/app/no-project/page';
import { describeProjectActionError } from '../apps/learning/lib/project-action-error';

const mocked = vi.hoisted(() => ({ profile: null as unknown, error: false }));
vi.mock('../apps/learning/lib/server/learner-profile', () => ({
  getLearnerProfile: () => {
    if (mocked.error) throw new StudyError('INTERNAL', {}, '身份文件损坏');
    return mocked.profile;
  },
}));
const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { createElement } = require('react') as {
  createElement: (type: unknown, props: unknown) => unknown;
};
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};
const profile: LearnerProfileDto = {
  schemaVersion: 1,
  uid: 'uid_10000000-0000-4000-8000-000000000001',
  displayName: '学习者',
  revision: 1,
  createdAt: '2026-10-04T00:00:00.000Z',
  registrationStatus: 'local_only',
  canInvite: false,
};
describe('global learner profile entry', () => {
  it('shows a readonly UID and honest offline status, with rename/copy controls', () => {
    const html = renderToStaticMarkup(createElement(LearnerProfile, { initialProfile: profile }));
    expect(html).toContain(profile.uid);
    expect(html).toMatch(/data-learner-uid="true"[^>]*readOnly=""/);
    expect(html).toContain('未通过本人认证时不能联网邀请');
    expect(html).toContain('在线认证与邀请状态请在共同课堂查看');
    expect(html).not.toContain('尚未完成在线登记');
    expect(html).toContain('复制 UID');
    expect(html).toContain('保存昵称');
    expect(html).not.toContain('sew:classroom:owner:v1');
    expect(html).toContain('数据库备份不会复制个人身份');
  });
  it('renders without a project and has a reachable entry from the empty state', () => {
    mocked.error = false;
    mocked.profile = profile;
    expect(renderToStaticMarkup(ProfilePage())).toContain(profile.uid);
    expect(renderToStaticMarkup(NoProjectPage())).toContain('href="/profile"');
  });
  it('keeps a damaged profile unavailable and offers a reread, without an editable UID', () => {
    mocked.error = true;
    const html = renderToStaticMarkup(ProfilePage());
    expect(html).toContain('身份文件损坏');
    expect(html).toContain('重新读取个人档案');
    expect(html).not.toContain('data-learner-uid');
    expect(html).not.toContain('data-save-learner-name');
    mocked.error = false;
  });
  it('explains known native identity errors without revealing arbitrary IPC paths', () => {
    expect(
      describeProjectActionError(
        new Error(
          'Error invoking remote method: PROJECT_NOT_AUTHORIZED: 这个项目已关联其他本地 UID。',
        ),
      ),
    ).toContain('原个人档案');
    expect(
      describeProjectActionError(new Error('INTERNAL: 本地学习者身份读取或保存失败')),
    ).toContain('不会改为另一个 UID');
    expect(
      describeProjectActionError(new Error('filesystem at C:/private-profile/account.json')),
    ).not.toContain('C:/');
  });
});
