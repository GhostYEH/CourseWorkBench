import { z } from 'zod';

/** Empty attempts belong to a scene only through their exact scene-specific ID. */
export const selectSceneAttempt = <T extends {
  session: { id: string; status: string; createdAt: string };
  records: readonly { sceneId?: string; seq: number }[];
}>(candidates: readonly T[], sceneId: string, baseId: string): T | undefined => {
  const scoped = candidates.filter(({ session, records }) => {
    if (session.status !== 'active' && session.status !== 'completed') return false;
    const belongs = records.some((record) => record.sceneId === sceneId);
    if (belongs && records.some((record) => record.sceneId !== sceneId)) {
      throw new Error('测验会话包含其他场景记录，不能恢复或提交；请开始新的测验。');
    }
    if (records.length > 0) return belongs;
    const suffix = session.id.startsWith(`${baseId}:retry:`) ? session.id.slice(`${baseId}:retry:`.length) : '';
    return session.status === 'active' && (session.id === baseId || /^[1-9]\d*$/.test(suffix));
  });
  return scoped.sort((left, right) => Date.parse(right.session.createdAt) - Date.parse(left.session.createdAt)
    || Number(right.session.status === 'active') - Number(left.session.status === 'active'))[0];
};

/** Untrusted durable draft text is checked before restoring checkbox state. */
export const readMultipleAnswer = (text: string, allowed: readonly string[]): string[] => {
  if (text === '') return [];
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('多选作答草稿损坏，无法恢复；请重新读取或开始新的测验。'); }
  const parsed = z.array(z.string()).max(100).safeParse(raw);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length
    || parsed.data.some((value) => !allowed.includes(value))) {
    throw new Error('多选作答草稿与当前题目不一致，无法恢复；请重新读取或开始新的测验。');
  }
  return parsed.data.sort();
};

export const writeMultipleAnswer = (values: readonly string[]): string => JSON.stringify([...new Set(values)].sort());

export const hasQuizAnswer = (type: 'single' | 'multiple' | 'short_answer', text: string, allowed: readonly string[]): boolean => {
  if (type === 'multiple') return readMultipleAnswer(text, allowed).length > 0;
  return type === 'single' ? allowed.includes(text) : text.trim().length > 0;
};

export const quizResultFeedback = (result?: { correct?: boolean | null; earned?: number | null; status?: string }): string => {
  if (result?.status === 'pending_review') return '作答已保存：待判分，尚未更新掌握。';
  const outcome = result?.correct === true ? '正确' : result?.correct === false ? '错误' : '判分结果待确认';
  return `服务端审核已保存：${outcome}${typeof result?.earned === 'number' ? `，得分 ${result.earned}` : ''}。`;
};
