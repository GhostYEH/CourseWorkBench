import { describe, expect, it } from 'vitest';
import type { PlanSceneDto } from '@sew/study-contracts';
import {
  createDraftSaveQueue,
  type DraftSnapshot,
} from '../apps/learning/components/lesson-scene-plan-draft-queue';

/**
 * 场景计划草稿串行保存队列（OMA-024 / 修复 3.3、3.5）。
 *
 * 固定：① 串行——任意时刻只有一个保存在途，旧请求不会晚于新请求到达；② 保留最后快照——
 * 保存期间到来的新编辑在在途完成后继续保存，最终落库的是最新快照；③ 草稿级 CAS 冲突后
 * 保留本地内容并停止自动保存，不覆盖另一窗口；④ reset 后迟到回调失效；失败不显示已保存。
 */

const scenes = (title: string): PlanSceneDto[] => [
  {
    sceneId: 'scene_slide_a',
    kind: 'slide',
    title,
    statementId: null,
    questionId: null,
    knowledgeIds: [],
    elements: [],
    note: '',
  },
];

const snapshot = (title: string): DraftSnapshot => ({
  baseRevision: 1,
  baseDigest: 'd'.repeat(64),
  scenes: scenes(title),
});

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('草稿串行保存队列', () => {
  it('串行保存并保留最后快照：在途期间的新编辑在完成后继续落库', async () => {
    const sent: string[] = [];
    let releaseFirst!: () => void;
    const queue = createDraftSaveQueue({
      send: async (snap) => {
        sent.push(snap.scenes[0]!.title);
        if (sent.length === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
        return { draftRevision: sent.length };
      },
      classifyError: () => ({}),
    });
    queue.submit(snapshot('第一次'));
    await flushMicrotasks();
    expect(sent).toEqual(['第一次']);
    // 在途期间连续提交两次：只有最后一个快照会在完成后被保存。
    queue.submit(snapshot('第二次'));
    queue.submit(snapshot('第三次'));
    releaseFirst();
    await queue.flush();
    expect(sent).toEqual(['第一次', '第三次']);
    expect(queue.knownRevision()).toBe(2);
    expect(queue.state()).toBe('saved');
    expect(queue.hasUnsaved()).toBe(false);
  });

  it('草稿级 CAS 冲突保留本地内容，不自动覆盖另一窗口的版本', async () => {
    const sent: Array<{ title: string; expected: number }> = [];
    const queue = createDraftSaveQueue({
      send: async (snap, expected) => {
        sent.push({ title: snap.scenes[0]!.title, expected });
        throw new Error('conflict');
      },
      classifyError: () => ({ conflictRevision: 4 }),
    });
    queue.submit(snapshot('旧窗口内容'));
    await flushMicrotasks();
    expect(sent).toEqual([{ title: '旧窗口内容', expected: 0 }]);
    expect(queue.state()).toBe('failed');
    expect(queue.knownRevision()).toBe(0);
    expect(queue.hasUnsaved()).toBe(true);
  });

  it.each(['success', 'failure'])('reset 后迟到的 %s 不恢复旧草稿或修改新基线', async (outcome) => {
    let resolve!: (result: { draftRevision: number }) => void;
    let reject!: (error: unknown) => void;
    let saved = 0;
    const queue = createDraftSaveQueue({
      send: () =>
        new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        }),
      classifyError: () => ({}),
      onSaved: () => {
        saved += 1;
      },
    });
    queue.submit(snapshot('已丢弃内容'));
    await flushMicrotasks();
    queue.reset();
    if (outcome === 'success') resolve({ draftRevision: 7 });
    else reject(new Error('late failure'));
    await queue.flush();
    expect(queue.state()).toBe('idle');
    expect(queue.knownRevision()).toBe(0);
    expect(queue.hasUnsaved()).toBe(false);
    expect(saved).toBe(0);
  });

  it('非冲突失败：保留最后快照、状态为 failed，不把失败当已保存', async () => {
    const queue = createDraftSaveQueue({
      send: async () => {
        throw new Error('network');
      },
      classifyError: () => ({}),
    });
    queue.submit(snapshot('离线编辑'));
    await flushMicrotasks();
    expect(queue.state()).toBe('failed');
    expect(queue.hasUnsaved()).toBe(true);
    // flush 在失败后不会无限重试；显式再提交才会重试。
  });

  it('flush 在无未保存编辑时立即返回；reset 清空基线', async () => {
    let calls = 0;
    const queue = createDraftSaveQueue({
      send: async () => {
        calls += 1;
        return { draftRevision: calls };
      },
      classifyError: () => ({}),
    });
    await queue.flush();
    expect(calls).toBe(0);
    queue.submit(snapshot('一次'));
    await queue.flush();
    expect(calls).toBe(1);
    queue.reset();
    expect(queue.state()).toBe('idle');
    expect(queue.knownRevision()).toBe(0);
    expect(queue.hasUnsaved()).toBe(false);
  });
});
