import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { crc32, isPortableZipPath, readZip, writeZip, ZipError } from '@sew/study-storage';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** 手工构造一个使用 deflate(8) 的归档，验证读取路径确实支持真实压缩流。 */
const makeDeflateZip = (entries: Array<{ path: string; content: string }>): Uint8Array => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const raw = Buffer.from(entry.content, 'utf8');
    const compressed = deflateRawSync(raw);
    const crc = crc32(new Uint8Array(raw));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBytes, end]));
};

describe('dependency-free zip archive', () => {
  it('round-trips stored entries and produces deterministic bytes', () => {
    const entries = [
      { path: 'manifest.json', bytes: text('{"a":1}') },
      { path: 'assets/a.png', bytes: new Uint8Array([0, 1, 2, 3]) },
      { path: 'index.html', bytes: text('<html></html>') },
    ];
    const first = writeZip(entries);
    const second = writeZip([...entries].reverse());
    expect([...first]).toEqual([...second]);

    const read = readZip(first);
    expect(read.map((entry) => entry.path)).toEqual([
      'assets/a.png',
      'index.html',
      'manifest.json',
    ]);
    expect(new TextDecoder().decode(read[2]!.bytes)).toBe('{"a":1}');
    expect([...read[0]!.bytes]).toEqual([0, 1, 2, 3]);
  });

  it('reads real deflate-compressed entries', () => {
    const archive = makeDeflateZip([
      { path: 'a.txt', content: 'hello '.repeat(50) },
      { path: 'b/c.txt', content: '世界' },
    ]);
    const read = readZip(archive);
    expect(new TextDecoder().decode(read[0]!.bytes)).toBe('hello '.repeat(50));
    expect(new TextDecoder().decode(read[1]!.bytes)).toBe('世界');
    expect(readZip(makeDeflateZip([{ path: 'empty.txt', content: '' }]))[0]!.bytes).toHaveLength(0);
  });

  it('rejects non-portable paths on write', () => {
    for (const path of ['/abs.txt', 'C:/x.txt', '../x.txt', 'a\\b.txt', 'a//b.txt', 'CON.txt']) {
      expect(() => writeZip([{ path, bytes: text('x') }])).toThrow(ZipError);
    }
    expect(isPortableZipPath('exports/lesson.json')).toBe(true);
    expect(isPortableZipPath('COM10.txt')).toBe(true);
  });

  it('rejects duplicate paths case-insensitively', () => {
    expect(() =>
      writeZip([
        { path: 'a.txt', bytes: text('1') },
        { path: 'A.txt', bytes: text('2') },
      ]),
    ).toThrow(ZipError);
  });

  it('rejects an empty archive', () => {
    expect(() => writeZip([])).toThrow(ZipError);
  });

  it('detects CRC tampering and truncation', () => {
    const archive = writeZip([{ path: 'a.txt', bytes: text('payload') }]);
    const tampered = Buffer.from(archive);
    const dataIndex = 30 + 'a.txt'.length; // 本地头 30 字节 + 文件名后即数据起点
    tampered.writeUInt8(tampered.readUInt8(dataIndex) ^ 0xff, dataIndex);
    expect(() => readZip(new Uint8Array(tampered))).toThrow(ZipError);
    expect(() => readZip(archive.subarray(0, archive.length - 4))).toThrow(ZipError);
  });

  it('rejects a deflate bomb past the compression ratio limit', () => {
    const archive = makeDeflateZip([{ path: 'a.txt', content: '\0'.repeat(1024 * 1024) }]);
    expect(() => readZip(archive)).toThrow(/compression_ratio_limit/);
  });

  it('stops a forged deflate size at the output limit before allocating the actual body', () => {
    const archive = Buffer.from(
      makeDeflateZip([{ path: 'a.txt', content: '\0'.repeat(8 * 1024 * 1024) }]),
    );
    const central = archive.readUInt32LE(archive.length - 22 + 16);
    archive.writeUInt32LE(1, 22);
    archive.writeUInt32LE(1, central + 24);
    expect(() => readZip(archive)).toThrow(/invalid_deflate_stream/);
  });

  it('rejects forged stored lengths before copying entry bytes', () => {
    const archive = writeZip([{ path: 'a.txt', bytes: text('payload') }]);
    const central = archive.readUInt32LE(archive.length - 22 + 16);
    archive.writeUInt32LE(1, 22);
    archive.writeUInt32LE(1, central + 24);
    expect(() => readZip(archive)).toThrow(/size_mismatch/);
  });

  it('rejects inconsistent local names, methods, lengths and entry aliases', () => {
    const original = writeZip([{ path: 'a.txt', bytes: text('payload') }]);
    const central = original.readUInt32LE(original.length - 22 + 16);
    const badName = Buffer.from(original);
    badName.write('../xx', 30, 'utf8');
    expect(() => readZip(badName)).toThrow(/local_header_mismatch/);
    const badMethod = Buffer.from(original);
    badMethod.writeUInt16LE(8, 8);
    expect(() => readZip(badMethod)).toThrow(/local_header_mismatch/);
    const badSize = Buffer.from(original);
    badSize.writeUInt32LE(1, 22);
    expect(() => readZip(badSize)).toThrow(/local_header_mismatch/);
    const alias = Buffer.from(original);
    alias.writeUInt32LE(central, central + 42);
    expect(() => readZip(alias)).toThrow(/local_header_out_of_range/);
  });

  it('rejects multi-disk and out-of-range central directories', () => {
    const archive = writeZip([{ path: 'a.txt', bytes: text('x') }]);
    const multiDisk = Buffer.from(archive);
    multiDisk.writeUInt16LE(1, archive.length - 22 + 4);
    expect(() => readZip(new Uint8Array(multiDisk))).toThrow(/multi_disk_unsupported/);
    const badOffset = Buffer.from(archive);
    badOffset.writeUInt32LE(0xfffffff0, archive.length - 22 + 16);
    expect(() => readZip(new Uint8Array(badOffset))).toThrow(ZipError);
  });
});
