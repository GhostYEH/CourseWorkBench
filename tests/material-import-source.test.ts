/// <reference path="../apps/learning/types/native.d.ts" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprintOf } from '@sew/study-domain';
import { createNodeSqliteDriver } from '@sew/study-storage';
import {
  authorizePaths, closeProject, materializeOriginalCopy, openProjectFromDisk, type Session,
} from '../apps/learning/lib/server/service';
import { POST as importMaterial } from '../apps/learning/app/api/study/materials/route';
import { GET as readMaterial } from '../apps/learning/app/api/study/materials/[materialId]/route';
import { GET as readMaterialRaw } from '../apps/learning/app/api/study/materials/[materialId]/raw/route';
import MaterialsPage from '../apps/learning/app/workbench/materials/page';

// Inspect the server page's output without mounting client forms or invoking hooks.
const pageOutput = (node: unknown): { text: string; elements: Record<string, unknown>[] } => {
  const words: string[] = [];
  const elements: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number') words.push(String(value));
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object' && 'props' in value) {
      const props = value.props;
      if (props && typeof props === 'object') {
        const record = props as Record<string, unknown>;
        elements.push(record);
        visit(record['children']);
      }
    }
  };
  visit(node);
  return { text: words.join(''), elements };
};

/** 断言抛出指定错误码的领域错误，而不是只断言「出错了」。 */
const expectStudyCode = (action: () => unknown, code: string): void => {
  try {
    action();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用成功了`);
};

describe('M1 材料导入与历史来源', () => {
  let session: Session;
  const roots: string[] = [];
  const temporaryDirectory = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'sew-material-source-'));
    roots.push(root);
    return root;
  };
  const post = (input: Record<string, unknown>) => importMaterial(new Request('http://service.local/api/study/materials', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: { projectId: session.projectId, generation: session.generation },
      displayName: '实际材料.md', type: 'md', readableLocation: '单元一', ...input,
    }),
  }));
  const get = (materialId: string, revision?: number) => readMaterial(
    new Request(`http://service.local/api/study/materials/${materialId}${revision ? `?revision=${revision}` : ''}`),
    { params: Promise.resolve({ materialId }) },
  );
  const getRaw = (materialId: string, revision: number, segmentId?: string) => readMaterialRaw(
    new Request(
      `http://service.local/api/study/materials/${materialId}/raw?revision=${revision}${segmentId ? `&segmentId=${segmentId}` : ''}`,
    ),
    { params: Promise.resolve({ materialId }) },
  );

  beforeEach(() => { session = openProjectFromDisk(temporaryDirectory()); });
  afterEach(() => {
    closeProject();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each(['', ' \t\r\n ', '\uFEFF\r\n'])('空粘贴正文 %j 拒绝导入，不写入材料', async (rawText) => {
    const response = await post({ mode: 'text', rawText });
    expect(response.status).toBe(400);
    expect((await response.json()).ok).toBe(false);
    expect(session.store.countRows('materials')).toBe(0);
  });

  it('空文件和非法 UTF-8 文件拒绝导入，不以替换字符伪造来源', async () => {
    const file = join(session.displayPath, 'source.md');
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x41, 0x00])]) {
      writeFileSync(file, bytes);
      const response = await post({ mode: 'file', sourcePath: file });
      expect(response.status).toBe(400);
      const result = await response.json();
      expect(result.ok).toBe(false);
      if (bytes.length) {
        expect(result.error.details.reason).toBe('invalid_utf8');
        expect(result.error.message).toContain('UTF-8');
      }
      expect(session.store.countRows('materials')).toBe(0);
    }
  });

  it('有效 UTF-8 的 BOM 与 CRLF 按固定规则规范化，保留中文和段内换行', async () => {
    const file = join(session.displayPath, 'source.md');
    writeFileSync(file, '\uFEFF# 单元一\r\n\r\n第一行中文\r\n第二行中文', 'utf8');
    const response = await post({ mode: 'file', sourcePath: file });
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.material.fingerprint).toBe(fingerprintOf('# 单元一\n\n第一行中文\n第二行中文'));
    expect(data.segments.map((segment: { text: string }) => segment.text)).toEqual(['# 单元一', '第一行中文\n第二行中文']);
  });

  it('替换材料后历史来源可按版本读取、选择与定位，重启仍保留原指纹', async () => {
    const initial = await post({ mode: 'text', rawText: '旧版原文\n\n旧版依据' });
    const old = (await initial.json()).data;
    await post({ mode: 'text', rawText: '新版原文\n\n新版依据' });
    expect(session.store.listMaterials()).toHaveLength(1);
    expect(session.store.listMaterialVersions(old.material.materialId).map((item) => item.revision)).toEqual([2, 1]);

    const root = session.displayPath;
    closeProject();
    session = openProjectFromDisk(root);
    const historical = (await (await get(old.material.materialId, 1)).json()).data;
    expect(historical.material.fingerprint).toBe(old.material.fingerprint);
    expect(historical.segments).toEqual(old.segments);
    expect(historical.versions.map((item: { revision: number }) => item.revision)).toEqual([2, 1]);
    const latest = (await (await get(old.material.materialId)).json()).data;
    expect(latest.material.revision).toBe(2);
    expect(latest.segments[1].text).toBe('新版依据');

    const view = pageOutput(await MaterialsPage({ searchParams: Promise.resolve({
      materialId: old.material.materialId, revision: '1', segment: 'S002',
    }) }));
    expect(view.text).toContain('旧版依据');
    expect(view.text).not.toContain('新版依据');
    expect(view.text).toContain('原始文件未归档');
    expect(view.text).not.toContain('原始文件已归档');
    expect(view.elements).toContainEqual(expect.objectContaining({ id: 'source-S002' }));
    expect(view.elements).toContainEqual(expect.objectContaining({ 'data-highlight': true, children: '旧版依据' }));
    expect(view.elements.some((props) => props['href'] === `/workbench/materials?materialId=${old.material.materialId}&revision=1&segment=S002#source-S002`)).toBe(true);
    expect(view.elements.some((props) => props['href'] === `/workbench/materials?materialId=${old.material.materialId}&revision=2`)).toBe(true);
  });

  it('不存在或错误的来源版本显式提示，不退回其他材料或最新正文', async () => {
    const { data } = await (await post({ mode: 'text', rawText: '实际正文' })).json();
    for (const query of [
      { materialId: 'missing', revision: '1' },
      { materialId: data.material.materialId, revision: '999' },
      { materialId: data.material.materialId, revision: 'invalid' },
      { revision: '1' },
    ]) {
      const view = pageOutput(await MaterialsPage({ searchParams: Promise.resolve(query) }));
      expect(view.text).toContain('指定的材料版本不存在或版本参数无效');
      expect(view.text).not.toContain('实际正文');
    }
  });

  it('正式历史读取不能用演示 materialId 越过范围隔离', async () => {
    const demo = session.store.importMaterial({
      projectId: session.projectId, displayName: '演示.md', materialType: 'md', rawText: '演示正文', recordScope: 'demo',
    });
    expect(session.store.listMaterialVersions(demo.material.materialId)).toEqual([]);
    expect((await get(demo.material.materialId, 1)).status).toBe(400);
    const view = pageOutput(await MaterialsPage({ searchParams: Promise.resolve({ materialId: demo.material.materialId, revision: '1' }) }));
    expect(view.text).not.toContain('演示正文');
  });

  it('等待路由参数期间切换项目，拒绝读取旧数据库且错误响应也禁止缓存', async () => {
    let resolveParams!: (value: { materialId: string }) => void;
    const params = new Promise<{ materialId: string }>((resolve) => { resolveParams = resolve; });
    const pending = readMaterial(new Request('http://service.local/api/study/materials/old'), { params });
    session = openProjectFromDisk(temporaryDirectory());
    resolveParams({ materialId: 'old' });
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).error.code).toBe('PROJECT_GENERATION_STALE');
  });

  it('等待页面查询期间切换项目，拒绝将旧来源页面显示为当前项目', async () => {
    let resolveQuery!: (value: { materialId: string }) => void;
    const searchParams = new Promise<{ materialId: string }>((resolve) => { resolveQuery = resolve; });
    const pending = MaterialsPage({ searchParams });
    session = openProjectFromDisk(temporaryDirectory());
    resolveQuery({ materialId: 'old' });
    await expect(pending).rejects.toMatchObject({ code: 'PROJECT_GENERATION_STALE' });
  });

  it('外部文件须有当前授权，路径穿越和 junction 不会取得项目内读取权限', async () => {
    const outside = temporaryDirectory();
    const file = join(outside, 'external.md');
    writeFileSync(file, '已授权实际材料', 'utf8');
    const junction = join(session.displayPath, 'outside');
    symlinkSync(outside, junction, 'junction');
    mkdirSync(join(session.displayPath, 'sources'));
    for (const sourcePath of [file, join(session.displayPath, '..', basename(outside), 'external.md'), join(junction, 'external.md')]) {
      expect((await post({ mode: 'file', sourcePath })).status).toBe(403);
    }
    expect(session.store.countRows('materials')).toBe(0);
    authorizePaths([file]);
    expect((await post({ mode: 'file', sourcePath: file })).status).toBe(200);
    session = openProjectFromDisk(session.displayPath);
    expect((await post({ mode: 'file', sourcePath: file })).status).toBe(403);
    expect(session.store.countRows('materials')).toBe(1);
  });

  it('文件导入按版本归档原始字节，段落可定位回原文的字节区间与行号', async () => {
    const file = join(session.displayPath, 'source.md');
    writeFileSync(file, '\uFEFF# 单元一\r\n\r\n第一行中文\r\n第二行中文\r\n\r\n  第三段（保留首尾空白）  ', 'utf8');
    const response = await post({ mode: 'file', sourcePath: file });
    expect(response.status).toBe(200);
    const { data } = await response.json();
    const bytes = readFileSync(file);

    expect(data.material.rawArchive).toEqual({
      state: 'archived',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
      mediaType: 'text/markdown',
      originalName: 'source.md',
      archivedAt: expect.any(String),
    });

    const expected = [
      { segmentId: 'S001', lineStart: 1, lineEnd: 1 },
      { segmentId: 'S002', lineStart: 3, lineEnd: 4 },
      { segmentId: 'S003', lineStart: 6, lineEnd: 6 },
    ];
    expect(data.segments).toHaveLength(expected.length);
    for (const [index, segment] of data.segments.entries()) {
      const span = expected[Number(index)] as (typeof expected)[number];
      expect(segment.segmentId).toBe(span.segmentId);
      expect(segment.rawLineStart).toBe(span.lineStart);
      expect(segment.rawLineEnd).toBe(span.lineEnd);
      // 字节区间解码后按同一规范化规则切出来，必须与登记的段落文本逐字相同。
      const sliced = Buffer.from(bytes.subarray(segment.rawStartByte, segment.rawEndByte)).toString('utf8');
      expect(sliced.replace(/\r\n?/g, '\n').trim()).toBe(segment.text);
    }
  });

  it('粘贴导入明确标记为未归档，不伪造可打开的原文', async () => {
    const { data } = await (await post({ mode: 'text', rawText: '粘贴的正文\r\n不保留原换行' })).json();
    expect(data.material.rawArchive).toEqual({ state: 'absent', reason: 'text_import' });
    expect(data.segments.every((segment: { rawStartByte: number | null }) => segment.rawStartByte === null)).toBe(true);

    const view = (await (await getRaw(data.material.materialId, 1)).json()).data;
    expect(view.archive).toEqual({ state: 'absent', reason: 'text_import' });
    expect(view.rawText).toBeNull();
    expect(view.segment).toBeNull();
  });

  it('原文视图返回与归档字节逐字相同的文本与段落定位', async () => {
    const file = join(session.displayPath, 'exam.md');
    writeFileSync(file, '考纲第一条\r\n\r\n考纲第二条', 'utf8');
    const imported = (await (await post({ mode: 'file', sourcePath: file, displayName: '考纲.md' })).json()).data;

    const response = await getRaw(imported.material.materialId, 1, 'S002');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const view = (await response.json()).data;
    expect(view.rawText).toBe('考纲第一条\r\n\r\n考纲第二条');
    expect(view.segment).toMatchObject({ segmentId: 'S002', text: '考纲第二条', lineStart: 3, lineEnd: 3 });
    expect(view.rawText.slice(view.segment.startChar, view.segment.endChar)).toBe('考纲第二条');

    const foreign = await getRaw(imported.material.materialId, 1, 'S999');
    expect(foreign.status).toBe(400);
    expect((await foreign.json()).error.code).toBe('SOURCE_SEGMENT_NOT_FOUND');
  });

  it('同一材料重新导入各自保留原文归档，旧版本来源链接不被改写', async () => {
    const file = join(session.displayPath, 'v.md');
    writeFileSync(file, '旧版原文', 'utf8');
    const first = (await (await post({ mode: 'file', sourcePath: file, displayName: '教材节选.md' })).json()).data;
    writeFileSync(file, '新版原文\n\n补充依据', 'utf8');
    const second = (await (await post({ mode: 'file', sourcePath: file, displayName: '教材节选.md' })).json()).data;
    expect(second.material.revision).toBe(2);

    const oldRaw = (await (await getRaw(first.material.materialId, 1)).json()).data;
    const newRaw = (await (await getRaw(first.material.materialId, 2)).json()).data;
    expect(oldRaw.rawText).toBe('旧版原文');
    expect(newRaw.rawText).toBe('新版原文\n\n补充依据');
    expect(oldRaw.archive.sha256).not.toBe(newRaw.archive.sha256);
    expect((await (await get(first.material.materialId, 1)).json()).data.material.fingerprint)
      .toBe(first.material.fingerprint);
  });

  it('归档字节与登记摘要不符时拒绝读取原文，不返回无法核对的内容', async () => {
    const file = join(session.displayPath, 'broken.md');
    writeFileSync(file, '第一段\r\n\r\n第二段', 'utf8');
    const data = (await (await post({ mode: 'file', sourcePath: file, displayName: '损坏.md' })).json()).data;
    const root = session.displayPath;
    closeProject();

    const db = createNodeSqliteDriver().open(join(root, '.study', 'study.db'));
    db.prepare('UPDATE source_raw_archives SET raw_bytes = ? WHERE material_id = ?')
      .run(Buffer.from('第一段\r\n\r\n第二段被改写', 'utf8'), data.material.materialId);
    db.close();

    session = openProjectFromDisk(root);
    const response = await getRaw(data.material.materialId, 1);
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe('MATERIAL_RAW_UNVERIFIED');
  });

  it('原文副本只写在项目内并复用同一路径；未归档与非法标识都明确拒绝', async () => {
    const file = join(session.displayPath, 'copy.md');
    writeFileSync(file, '需要打开的原文', 'utf8');
    const data = (await (await post({ mode: 'file', sourcePath: file, displayName: '副本.md' })).json()).data;

    const first = materializeOriginalCopy(session, data.material.materialId, 1);
    const again = materializeOriginalCopy(session, data.material.materialId, 1);
    expect(again.path).toBe(first.path);
    expect(first.path.startsWith(join(session.displayPath, 'exports', 'originals'))).toBe(true);
    expect(readFileSync(first.path, 'utf8')).toBe('需要打开的原文');
    expect(first.displayName).toBe('copy.md');

    expectStudyCode(() => materializeOriginalCopy(session, '../evil', 1), 'INVALID_ARGUMENT');
    const pasted = (await (await post({ mode: 'text', rawText: '粘贴正文', displayName: '粘贴材料.md' })).json()).data;
    expectStudyCode(
      () => materializeOriginalCopy(session, pasted.material.materialId, 1),
      'MATERIAL_RAW_ABSENT',
    );
  });
});
