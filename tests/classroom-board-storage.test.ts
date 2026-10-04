import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyError } from '@sew/study-contracts';
import { createNodeSqliteDriver } from '@sew/study-storage';
import { classroomBoardContentSchema } from '../packages/study-contracts/src/classroom-board';
import { MIGRATIONS } from '../packages/study-storage/src/schema';
import { ClassroomBoardRepository, type CreateClassroomBoardInput } from '../packages/study-storage/src/repositories/classroom-board';

describe('evidence-bound persistent classroom board', () => {
  const roots: string[] = []; const closers: Array<() => void> = [];
  afterEach(() => { closers.splice(0).forEach(close => close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'sew-board-')); roots.push(root);
    const file = join(root, 'board.sqlite'); const db = createNodeSqliteDriver().open(file); closers.push(() => db.close()); db.exec(MIGRATIONS.find(migration => migration.version === 21)!.sql);
    const flags = { source: true, status: 'in_class', sceneId: 'scene', lessonVersion: 1 };
    const facts: ConstructorParameters<typeof ClassroomBoardRepository>[1] = {
      assertBinding: binding => {
        if (!flags.source) throw new StudyError('KNOWLEDGE_INVALIDATED');
        if (binding.projectId !== 'p' || binding.lessonId !== 'lesson' || binding.lessonVersion !== flags.lessonVersion
          || binding.sceneId !== 'scene' || binding.statementIds.some(id => id !== 'statement')) throw new StudyError('VERSION_CONFLICT');
      },
      assertPlayable: (sessionId, binding) => {
        if (sessionId !== 'session' || binding.sceneId !== flags.sceneId) throw new StudyError('VERSION_CONFLICT');
        if (flags.status === 'awaiting_learner') throw new StudyError('CLASSROOM_AWAITING_LEARNER');
        if (flags.status !== 'in_class') throw new StudyError('RUN_TERMINATED');
      },
      sessionBinding: (projectId, sessionId) => {
        if (projectId !== 'p' || sessionId !== 'session') throw new StudyError('NOT_FOUND');
        return { lessonId: 'lesson', lessonVersion: 1 };
      },
    };
    const repo = new ClassroomBoardRepository(db, facts);
    const create: CreateClassroomBoardInput = { projectId: 'p', lessonId: 'lesson', lessonVersion: 1, sceneId: 'scene', statementIds: ['statement'],
      content: { kind: 'text', text: '审核后的定义文字' }, actor: 'local_user', requestId: 'create' };
    const approve = () => {
      const { item } = repo.create(create);
      return repo.review({ projectId: 'p', actor: 'local_user', requestId: 'review', itemId: item.itemId, expectedVersion: 1,
        decision: 'approved', semanticReviewed: true, note: '已核对冻结定义和条件' }).item;
    };
    const play = (itemId: string) => ({ projectId: 'p', actor: 'teacher', requestId: 'play', sessionId: 'session', itemId, expectedVersion: 2, expectedSeq: 0 });
    return { file, db, facts, flags, repo, create, approve, play };
  };
  it('persists reviewed text, formula, diagram and highlighter with monotonically ordered effects', () => {
    const f = fixture();
    const contents = [f.create.content, { kind: 'formula' as const, text: 'f(x)=x^2', latex: 'f(x)=x^{2}' },
      { kind: 'diagram' as const, nodes: [{ id: 'a', label: '输入', x: 20, y: 20 }, { id: 'b', label: '输出', x: 80, y: 80 }], edges: [{ from: 'a', to: 'b' }] },
      { kind: 'highlight' as const, statementId: 'statement', text: '关注适用条件' }];
    contents.forEach((content, index) => {
      const created = f.repo.create({ ...f.create, content, requestId: `create${index}` });
      expect(f.repo.state('p', 'session').effects).toHaveLength(index);
      const reviewed = f.repo.review({ projectId: 'p', actor: 'local_user', requestId: `review${index}`, itemId: created.item.itemId, expectedVersion: 1, decision: 'approved', semanticReviewed: true, note: '逐条核对' });
      const played = f.repo.play({ ...f.play(reviewed.item.itemId), requestId: `play${index}`, expectedSeq: index });
      expect(played.effect).toMatchObject({ seq: index + 1, actor: 'teacher', item: { status: 'approved', version: 2, content } });
    });
    expect(f.repo.state('p', 'session').seq).toBe(4);
  });
  it('replays identical commands without effects and rejects reused nonce with different intent', () => {
    const f = fixture(); const first = f.repo.create(f.create);
    expect(f.repo.create(f.create)).toMatchObject({ deduplicated: true, item: first.item });
    expect(() => f.repo.create({ ...f.create, content: { kind: 'text', text: '不同内容' } })).toThrow();
    const item = f.approve(); const played = f.repo.play(f.play(item.itemId));
    expect(f.repo.play(f.play(item.itemId))).toEqual({ ...played, deduplicated: true });
    expect(() => f.repo.play({ ...f.play(item.itemId), expectedSeq: 1 })).toThrow();
    expect(() => f.repo.play({ ...f.play(item.itemId), requestId: 'again', expectedSeq: 1 })).toThrow();
    expect(f.repo.state('p', 'session').effects).toHaveLength(1);
  });
  it.each(['peer_ai', 'learner', 'editor_agent'])('refuses %s authoring, review and playback authority', actor => {
    const f = fixture(); const item = f.approve();
    expect(() => f.repo.create({ ...f.create, actor, requestId: 'forbidden-create' })).toThrow();
    expect(() => f.repo.review({ projectId: 'p', actor, requestId: 'forbidden-review', itemId: item.itemId, expectedVersion: 2, decision: 'approved', semanticReviewed: true, note: '自审' })).toThrow();
    expect(() => f.repo.play({ ...f.play(item.itemId), actor })).toThrow();
    expect(f.repo.state('p', 'session').effects).toEqual([]);
  });
  it('does not allow unreviewed or rejected content onto the teaching canvas', () => {
    const f = fixture(); const draft = f.repo.create(f.create).item;
    expect(() => f.repo.play({ ...f.play(draft.itemId), expectedVersion: 1 })).toThrow();
    f.repo.review({ projectId: 'p', actor: 'local_user', requestId: 'reject', itemId: draft.itemId, expectedVersion: 1, decision: 'rejected', semanticReviewed: true, note: '内容未核实' });
    expect(() => f.repo.play(f.play(draft.itemId))).toThrow();
  });
  it.each(['awaiting_learner', 'completed', 'cancelled', 'source', 'scene', 'version'])('refuses new %s effects while keeping committed history readable', state => {
    const f = fixture(); const item = f.approve(); f.repo.play(f.play(item.itemId));
    const other = f.repo.create({ ...f.create, requestId: 'create2' }).item;
    const approved = f.repo.review({ projectId: 'p', actor: 'local_user', requestId: 'review2', itemId: other.itemId, expectedVersion: 1, decision: 'approved', semanticReviewed: true, note: '核对' }).item;
    if (state === 'source') f.flags.source = false;
    else if (state === 'scene') f.flags.sceneId = 'other';
    else if (state === 'version') f.flags.lessonVersion = 2;
    else f.flags.status = state;
    expect(() => f.repo.play({ ...f.play(approved.itemId), requestId: 'play2', expectedSeq: 1 })).toThrow();
    expect(f.repo.state('p', 'session').effects).toHaveLength(1);
    expect(f.repo.play(f.play(item.itemId)).deduplicated).toBe(true);
  });
  it('rejects stale CAS review and sequence without partially committing', () => {
    const f = fixture(); const item = f.approve();
    expect(() => f.repo.review({ projectId: 'p', actor: 'local_user', requestId: 'review-stale', itemId: item.itemId, expectedVersion: 1, decision: 'approved', semanticReviewed: true, note: '重复审核' })).toThrow();
    expect(() => f.repo.play({ ...f.play(item.itemId), expectedSeq: 5 })).toThrow();
    expect(f.repo.state('p', 'session').seq).toBe(0);
  });
  it('rolls back an effect when receipt insertion fails and allows the same nonce afterward', () => {
    const f = fixture(); const item = f.approve();
    f.db.exec("CREATE TRIGGER fail_board_receipt BEFORE INSERT ON classroom_board_receipts WHEN NEW.action='play' BEGIN SELECT RAISE(ABORT,'fixture_receipt_failed'); END;");
    expect(() => f.repo.play(f.play(item.itemId))).toThrow(); expect(f.repo.state('p', 'session').effects).toEqual([]);
    f.db.exec('DROP TRIGGER fail_board_receipt'); expect(f.repo.play(f.play(item.itemId)).effect.seq).toBe(1);
  });
  it('rolls back draft creation and review when their receipt cannot commit', () => {
    const f = fixture();
    f.db.exec("CREATE TRIGGER fail_create_receipt BEFORE INSERT ON classroom_board_receipts WHEN NEW.action='create' BEGIN SELECT RAISE(ABORT,'fixture_failed'); END;");
    expect(() => f.repo.create(f.create)).toThrow(); expect(f.repo.listItems('p', 'lesson', 1)).toEqual([]);
    f.db.exec('DROP TRIGGER fail_create_receipt'); const item = f.repo.create(f.create).item;
    f.db.exec("CREATE TRIGGER fail_review_receipt BEFORE INSERT ON classroom_board_receipts WHEN NEW.action='review' BEGIN SELECT RAISE(ABORT,'fixture_failed'); END;");
    expect(() => f.repo.review({ projectId: 'p', actor: 'local_user', requestId: 'review', itemId: item.itemId, expectedVersion: 1, decision: 'approved', semanticReviewed: true, note: '核对' })).toThrow();
    expect(f.repo.getItem('p', item.itemId)).toMatchObject({ status: 'draft', version: 1 });
  });
  it('refuses create/review when evidence changes, and requires explicit semantic confirmation', () => {
    const f = fixture(); const item = f.repo.create(f.create).item;
    const review = { projectId: 'p', actor: 'local_user', requestId: 'review', itemId: item.itemId, expectedVersion: 1, decision: 'approved' as const, semanticReviewed: true as const, note: '核对' };
    expect(() => f.repo.review({ ...review, semanticReviewed: false as unknown as true })).toThrow();
    f.flags.source = false;
    expect(() => f.repo.create({ ...f.create, requestId: 'source-failed' })).toThrow();
    expect(() => f.repo.review(review)).toThrow();
    expect(f.repo.getItem('p', item.itemId)?.status).toBe('draft');
  });
  it('restores exact reviewed effects on reopen without executing them again', () => {
    const f = fixture(); const item = f.approve(); const played = f.repo.play(f.play(item.itemId));
    const db = createNodeSqliteDriver().open(f.file); closers.push(() => db.close());
    const reopened = new ClassroomBoardRepository(db, f.facts);
    expect(reopened.state('p', 'session').effects).toEqual([played.effect]);
    expect(reopened.play(f.play(item.itemId)).deduplicated).toBe(true);
    expect(reopened.state('p', 'session').seq).toBe(1);
  });
  it('rejects HTML, executable payloads, unknown geometry and outside evidence highlighting', () => {
    for (const content of [{ kind: 'text', text: '<script>alert(1)</script>' }, { kind: 'formula', text: 'javascript:alert(1)' },
      { kind: 'diagram', nodes: [{ id: 'a', label: '节点', x: 0, y: 0 }], edges: [{ from: 'a', to: 'missing' }] },
      { kind: 'diagram', nodes: [{ id: 'a', label: '节点', x: -1, y: 0 }], edges: [] }]) expect(classroomBoardContentSchema.safeParse(content).success).toBe(false);
    const f = fixture(); expect(() => f.repo.create({ ...f.create, content: { kind: 'highlight', statementId: 'outside', text: '未绑定' } })).toThrow();
  });
  it('fails closed on corrupted historical effect JSON instead of rendering it', () => {
    const f = fixture(); const item = f.approve(); f.repo.play(f.play(item.itemId));
    f.db.prepare('UPDATE classroom_board_effects SET effect_json=?').run('{"unreviewed":true}');
    expect(() => f.repo.state('p', 'session')).toThrow();
  });
});
