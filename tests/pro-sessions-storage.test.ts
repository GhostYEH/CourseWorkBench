import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeSqliteDriver } from '@sew/study-storage';
import { applyMigrations } from '../packages/study-storage/src/schema';
import {
  ProSessionsRepository,
  ProSkillsRepository,
} from '../packages/study-storage/src/repositories/pro-sessions';
import { createProSession, appendProMessage } from '../packages/study-domain/src/pro-session';

const timestamp = '2026-10-08T12:00:00.000Z';
const digest = 'a'.repeat(64);
const record = () =>
  createProSession({
    sessionId: 'session_1',
    projectId: 'project_1',
    learnerUid: 'owner_1',
    requestId: 'create_1',
    intentDigest: digest,
    title: '课程',
    now: timestamp,
  });

describe('private Pro SQLite records', () => {
  it('reopens durable history, isolates owners and rejects stale revisions or rewritten history', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-pro-db-'));
    const path = join(root, 'project.sqlite');
    let db = createNodeSqliteDriver().open(path);
    applyMigrations(db);
    try {
      let sessions = new ProSessionsRepository(db);
      const initial = sessions.create(record());
      const next = appendProMessage(initial, 0, {
        messageId: 'message_1',
        requestId: 'send_1',
        intentDigest: digest,
        role: 'user',
        content: '请继续',
        eventType: 'user_message',
        now: timestamp,
      });
      sessions.update(next, 0);
      expect(() => sessions.update({ ...next, title: 'stale' }, 0)).toThrow();
      expect(sessions.get('project_1', 'other_owner', initial.sessionId)).toBeNull();
      expect(sessions.list('other_project', initial.learnerUid)).toEqual([]);
      expect(() =>
        sessions.update(
          { ...next, revision: 2, messages: [{ ...next.messages[0]!, content: '改写历史' }] },
          1,
        ),
      ).toThrow();
      expect(() =>
        sessions.update(
          {
            ...next,
            revision: 2,
            events: [{ ...next.events[0]!, message: '改写事件' }, next.events[1]!],
          },
          1,
        ),
      ).toThrow();
      expect(() => sessions.update({ ...next, revision: 2, requestId: 'changed' }, 1)).toThrow();
      db.close();
      db = createNodeSqliteDriver().open(path);
      sessions = new ProSessionsRepository(db);
      expect(sessions.get(initial.projectId, initial.learnerUid, initial.sessionId)).toEqual(next);
      expect(sessions.create(record())).toEqual(next);
      expect(() =>
        sessions.byRequest(
          initial.projectId,
          initial.learnerUid,
          initial.requestId,
          'b'.repeat(64),
        ),
      ).toThrow();
      expect(() =>
        sessions.delete(initial.projectId, 'other_owner', initial.sessionId, 1),
      ).toThrow();
      sessions.delete(initial.projectId, initial.learnerUid, initial.sessionId, 1);
      expect(sessions.get(initial.projectId, initial.learnerUid, initial.sessionId)).toBeNull();
      expect(() => sessions.create(record())).toThrow();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps custom skills owner-bound with revision checks and nonce tombstones', () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-pro-skills-'));
    const db = createNodeSqliteDriver().open(join(root, 'project.sqlite'));
    applyMigrations(db);
    try {
      const skills = new ProSkillsRepository(db);
      const skill = {
        skillId: 'skill_1',
        projectId: 'project_1',
        learnerUid: 'owner_1',
        requestId: 'import_1',
        intentDigest: digest,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        name: '数学',
        title: '数学课件',
        description: '按照来源编辑',
        content: '不要虚构事实',
        enabled: true,
      };
      skills.create(skill);
      expect(skills.get('project_1', 'other', skill.skillId)).toBeNull();
      expect(skills.update({ ...skill, revision: 2, enabled: false }, 1).enabled).toBe(false);
      expect(() => skills.update({ ...skill, revision: 2 }, 1)).toThrow();
      skills.delete(skill.projectId, skill.learnerUid, skill.skillId, 2);
      expect(() => skills.create(skill)).toThrow();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
