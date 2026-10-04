import Link from 'next/link';
import { isStudyError, type LearnerProfileDto } from '@sew/study-contracts';
import { LearnerProfile } from '../../components/learner-profile';
import { getLearnerProfile } from '../../lib/server/learner-profile';

export const dynamic = 'force-dynamic';

export default function ProfilePage() {
  let profile: LearnerProfileDto | null = null;
  let error: string | null = null;
  try { profile = getLearnerProfile(); }
  catch (caught) { error = isStudyError(caught) ? caught.message : '个人档案暂时无法读取，请稍后重新读取。'; }
  return <main className="page">
    <div className="page-head"><div><h1>个人档案</h1><p>个人身份与科目设置分开保存，无需打开科目也能查看。</p></div></div>
    <LearnerProfile initialProfile={profile} initialError={error} />
    <p><Link className="btn" href="/workbench">返回工作台</Link> <Link className="btn" href="/no-project">选择科目项目</Link></p>
  </main>;
}
