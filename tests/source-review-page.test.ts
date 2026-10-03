import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProject, openProjectFromDisk } from '../apps/learning/lib/server/service';
import SourceReviewPage from '../apps/learning/app/workbench/review/page';

describe('独立来源审核入口', () => {
  let root: string | undefined;

  afterEach(() => {
    closeProject();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('页面读取只展示候选，不自动创建候选或权威知识', () => {
    root = mkdtempSync(join(tmpdir(), 'sew-source-review-'));
    const session = openProjectFromDisk(root);

    const page = SourceReviewPage();

    expect(page).not.toBeNull();
    expect(session.store.listProposals()).toEqual([]);
    expect(session.store.listKnowledge()).toEqual([]);
  });
});
