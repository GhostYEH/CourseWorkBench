import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import LibraryPage from '../apps/learning/app/workbench/library/page';
import {
  closeProject,
  openProjectFromDisk,
  type Session,
} from '../apps/learning/lib/server/service';
import { ensureFixedLesson, reviewedLesson } from '../apps/learning/lib/server/classroom-service';
import {
  filterLibraryGroups,
  groupLibraryDocuments,
  type LibraryDocumentDto,
  type LibraryFolderDto,
} from '../apps/learning/lib/document-library';

/**
 * 课程库浏览与组织（OMA-001 / OMA-002）。
 *
 * 页面只消费服务端读取的权威存储：列表来自 `listClassroomDocuments`，归属来自
 * `listClassroomDocumentFolderIds`。这里验证分组/筛选纯函数，以及页面确实呈现了
 * 真实文档与文件夹归属——它不是浏览器点击记录，但读取本身不产生任何组织写入。
 */

const require = createRequire(new URL('../apps/learning/package.json', import.meta.url));
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};
const { createElement } = require('react') as {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown;
};
const { AppRouterContext } = require('next/dist/shared/lib/app-router-context.shared-runtime') as {
  AppRouterContext: { Provider: unknown };
};
const render = (element: unknown) =>
  renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      {
        value: {
          back: () => {},
          forward: () => {},
          refresh: () => {},
          hmrRefresh: () => {},
          push: () => {},
          replace: () => {},
          prefetch: () => {},
        },
      },
      element,
    ),
  );

const document = (overrides: Partial<LibraryDocumentDto> = {}): LibraryDocumentDto => ({
  stageId: 'stage-1',
  lessonId: 'lesson-1',
  name: '文档一',
  description: '',
  recordScope: 'formal',
  sceneCount: 3,
  sourceCount: 3,
  assetCount: 1,
  folderId: null,
  updatedAt: 0,
  ...overrides,
});

describe('课程库分组与筛选（纯函数）', () => {
  const folders: LibraryFolderDto[] = [
    { id: 'folder-b', name: '乙组', order: 1 },
    { id: 'folder-a', name: '甲组', order: 0 },
  ];

  it('按文件夹顺序分组，空文件夹保留，未分组单独成组', () => {
    const groups = groupLibraryDocuments(
      [
        document({ stageId: 's1', folderId: 'folder-a' }),
        document({ stageId: 's2', folderId: null }),
        document({ stageId: 's3', folderId: 'folder-a' }),
      ],
      folders,
    );
    expect(groups.map((group) => group.folder?.id ?? 'unfiled')).toEqual([
      'folder-a',
      'folder-b',
      'unfiled',
    ]);
    expect(groups[0]!.documents.map((item) => item.stageId)).toEqual(['s1', 's3']);
    expect(groups[1]!.documents).toEqual([]);
    expect(groups[2]!.documents.map((item) => item.stageId)).toEqual(['s2']);
  });

  it('筛选按名称/描述/编号命中，文件夹名命中时保留其全部文档，空组剔除', () => {
    const groups = groupLibraryDocuments(
      [
        document({ stageId: 's1', name: '函数单调性', folderId: 'folder-a' }),
        document({ stageId: 's2', name: '无关', folderId: 'folder-b' }),
      ],
      folders,
    );
    const byName = filterLibraryGroups(groups, '单调');
    expect(byName).toHaveLength(1);
    expect(byName[0]!.folder?.id).toBe('folder-a');
    const byFolder = filterLibraryGroups(groups, '乙组');
    expect(byFolder).toHaveLength(1);
    expect(byFolder[0]!.documents.map((item) => item.stageId)).toEqual(['s2']);
    expect(filterLibraryGroups(groups, '不存在')).toEqual([]);
  });
});

describe('课程库页面（服务端读取）', () => {
  let root: string;
  let session: Session;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sew-library-page-'));
    session = openProjectFromDisk(root);
    ensureFixedLesson(session);
  });

  afterEach(() => {
    closeProject();
    rmSync(root, { recursive: true, force: true });
  });

  const html = (): string => render(LibraryPage());

  it('呈现真实文档，未分组计数与文档身份来自权威存储', () => {
    const rendered = html();
    expect(rendered).toContain('data-lesson-library');
    expect(rendered).toContain(reviewedLesson.stageId);
    expect(rendered).toContain('未分组（1）');
    expect(rendered).toContain('演示');
    expect(rendered).toContain('新建文件夹');
  });

  it('文件夹归属与空文件夹在页面上可见，取消分组后文档回到未分组', () => {
    const folder = session.store.createClassroomFolder(
      session.projectId,
      'folder-library-page',
      '已发布课件',
    ).folder;
    expect(
      session.store.setClassroomDocumentFolder(
        session.projectId,
        reviewedLesson.stageId,
        folder.id,
      ),
    ).toBe(true);

    let rendered = html();
    expect(rendered).toContain('已发布课件');
    expect(rendered).toContain('data-library-folder="folder-library-page"');
    expect(rendered).toContain('未分组（0）');

    // 第二个空文件夹同样保留在页面上。
    session.store.createClassroomFolder(session.projectId, 'folder-empty', '空文件夹');
    rendered = html();
    expect(rendered).toContain('空文件夹');
    expect(rendered).toContain('（空文件夹，可重启读回）');

    expect(
      session.store.setClassroomDocumentFolder(session.projectId, reviewedLesson.stageId, null),
    ).toBe(true);
    rendered = html();
    expect(rendered).toContain('未分组（1）');
  });

  it('页面读取不产生任何组织写入', () => {
    session.store.createClassroomFolder(session.projectId, 'folder-stable', '稳定组');
    const before = JSON.stringify(session.store.listClassroomFolders(session.projectId));
    const beforeMembership = JSON.stringify([
      ...session.store.listClassroomDocumentFolderIds(session.projectId),
    ]);
    html();
    html();
    expect(JSON.stringify(session.store.listClassroomFolders(session.projectId))).toBe(before);
    expect(
      JSON.stringify([...session.store.listClassroomDocumentFolderIds(session.projectId)]),
    ).toBe(beforeMembership);
  });
});
