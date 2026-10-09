import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeSqliteDriver } from '@sew/study-storage';
import { interactiveSnapshotStateSchema } from '@sew/study-contracts';
import { decideInteractiveSnapshot } from '@sew/study-domain';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';
import { ensureFixedLesson } from '../apps/learning/lib/server/classroom-service';
import { commandInteractiveSnapshot } from '../apps/learning/lib/server/interactive-snapshot-service';

/**
 * 互动保活与快照恢复（OMA-045）。
 *
 * 固定：① 只有组件版本一致才恢复；版本变化或没有快照 → 明确重置并给出原因；
 * ② 快照按 (项目, stage, 场景, 本人) 分区，重启读回；③ 快照不写本人已提交记录；
 * ④ 客户端不能自报版本（服务端按当前文档摘要盖章）。
 */
describe('OMA-045 互动保活与快照恢复', () => {
  it('纯函数：版本一致才恢复，版本变化明确重置', () => {
    const stored = { widgetVersion: 'v1', data: { a: 2 }, updatedAt: '2026-10-09T00:00:00.000Z' };
    expect(decideInteractiveSnapshot({ currentWidgetVersion: 'v1', stored })).toMatchObject({
      restored: true,
      reason: 'restored',
      data: { a: 2 },
    });
    expect(decideInteractiveSnapshot({ currentWidgetVersion: 'v2', stored })).toMatchObject({
      restored: false,
      reason: 'widget_version_changed',
      data: null,
    });
    expect(decideInteractiveSnapshot({ currentWidgetVersion: 'v1', stored: null })).toMatchObject({
      restored: false,
      reason: 'none',
    });
  });

  it('服务端写入/读取/清除：重启读回，快照不写本人已提交记录', () => {
    let directory: string | null = null;
    let session: Session | null = null;
    try {
      directory = mkdtempSync(join(tmpdir(), 'sew-snapshot-'));
      session = openProjectFromDisk(directory);
      const s = session;
      const ensured = ensureFixedLesson(s);
      const scope = { projectId: s.projectId, generation: s.generation };
      const stageId = ensured.stageId;
      const sceneId = 'scene-interactive-parameter';
      for (const invalidScene of ['missing-scene', 'scene-slide-intro']) {
        expect(() =>
          commandInteractiveSnapshot(s, {
            operation: 'write',
            scope,
            stageId,
            sceneId: invalidScene,
            data: { a: 2 },
          }),
        ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
      }

      const written = commandInteractiveSnapshot(s, {
        operation: 'write',
        scope,
        stageId,
        sceneId,
        data: { a: 2.5 },
      });
      expect(interactiveSnapshotStateSchema.safeParse(written).success).toBe(true);
      expect(written.restored).toBe(true);
      expect(written.snapshot!.data).toEqual({ a: 2.5 });

      // 重启读回（等价：独立连接读取）。
      const read = commandInteractiveSnapshot(s, { operation: 'read', scope, stageId, sceneId });
      expect(read.restored).toBe(true);
      expect(read.snapshot!.data).toEqual({ a: 2.5 });
      // 快照不写任何本人已提交记录。
      expect(s.store.listAttempts(undefined, 'formal').length).toBe(0);

      // 清除后明确重置。
      commandInteractiveSnapshot(s, { operation: 'clear', scope, stageId, sceneId });
      const afterClear = commandInteractiveSnapshot(s, {
        operation: 'read',
        scope,
        stageId,
        sceneId,
      });
      expect(afterClear.restored).toBe(false);
      expect(afterClear.reason).toBe('none');

      // 直接改库中快照的组件版本，模拟文档变化 → 明确重置。
      commandInteractiveSnapshot(s, {
        operation: 'write',
        scope,
        stageId,
        sceneId,
        data: { a: 1 },
      });
      const db = createNodeSqliteDriver().open(s.store.databaseFile);
      try {
        db.prepare('UPDATE interactive_snapshots SET widget_version=?').run('stale-version');
      } finally {
        db.close();
      }
      const stale = commandInteractiveSnapshot(s, { operation: 'read', scope, stageId, sceneId });
      expect(stale.restored).toBe(false);
      expect(stale.reason).toBe('widget_version_changed');
    } finally {
      if (session) closeProject();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
});
