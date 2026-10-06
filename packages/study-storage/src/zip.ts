/**
 * 无第三方依赖的 ZIP 容器读写（OMA-067…072 的打包基础）。
 *
 * 为什么自己实现：仓库里没有任何 zip 写入依赖，而导出必须产出**可移植、可校验**的
 * 归档。这里只做两件事：
 * - 写：把若干（相对路径, 字节）条目按 ZIP 规范打成单文件，采用 stored（不压缩），
 *   因此输出是**确定性**的——同一组输入永远得到同一份字节，便于对照摘要与复验；
 * - 读：从中央目录解析条目，逐条校验 CRC32、长度与路径可移植性，任何不一致都
 *   fail-closed（抛 `ZipError`），不把损坏归档当成「能读一部分」。
 *
 * 读取支持 stored(0) 与 deflate(8) 两种方法，用于导入外部归档；写入只产出 stored，
 * 避免依赖压缩器版本导致输出漂移。ZIP 结构本身不可信：偏移、长度、条目数都先按上限
 * 与边界校验，再分配内存。
 */

import { inflateRawSync } from 'node:zlib';
import { TextDecoder } from 'node:util';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_BYTES = 22;
const EOCD_MAX_COMMENT = 0xffff;
/** 只写 stored；读取额外接受 deflate。 */
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** 单文件归档上限：条目数、单条与总量都设上限，避免恶意归档撑爆内存。 */
export const ZIP_MAX_ENTRIES = 20000;
export const ZIP_MAX_ENTRY_BYTES = 1024 ** 3;
export const ZIP_MAX_TOTAL_BYTES = 2 * 1024 ** 3;
/** 压缩比上限（解压后 / 压缩后），用于识别 deflate 炸弹；stored 恒为 1。 */
const ZIP_MAX_RATIO = 200;
const MAX_PATH_LENGTH = 1024;

export class ZipError extends Error {
  constructor(readonly reason: string) {
    super(`ZIP 归档不可用：${reason}`);
    this.name = 'ZipError';
  }
}
const fail = (reason: string): never => {
  throw new ZipError(reason);
};

// ——————————————————————————— CRC32 ———————————————————————————

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

// ——————————————————————————— 路径可移植性 ———————————————————————————

/**
 * 归档内路径必须是可移植的相对 POSIX 路径：拒绝绝对路径、盘符、反斜杠、`..`、
 * 控制字符、Windows 保留设备名与结尾的 `.`/空格。与项目备份的判定同源，避免
 * 「备份拒绝、导出放行」的口径分裂。
 */
export const isPortableZipPath = (path: string): boolean =>
  path.length > 0 &&
  path.length <= MAX_PATH_LENGTH &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  path
    .split('/')
    .every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        !/[<>:"|?*\x00-\x1f]/.test(part) &&
        !/[. ]$/.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    );

// ——————————————————————————— 写入 ———————————————————————————

export interface ZipEntryInput {
  /** 归档内相对路径（POSIX 分隔）。 */
  path: string;
  bytes: Uint8Array;
}

/** 固定 DOS 时间戳（1980-01-01 00:00），保证输出与运行时刻无关。 */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

const writeUInt32 = (target: Buffer, value: number, offset: number): void => {
  target.writeUInt32LE(value >>> 0, offset);
};
const writeUInt16 = (target: Buffer, value: number, offset: number): void => {
  target.writeUInt16LE(value & 0xffff, offset);
};

/**
 * 打包为 stored ZIP。条目按路径排序，保证输出确定性；路径不合法或超限时直接拒绝。
 */
export const writeZip = (entries: readonly ZipEntryInput[]): Buffer => {
  if (entries.length === 0) fail('empty_archive');
  if (entries.length > ZIP_MAX_ENTRIES) fail('entry_limit');
  const seen = new Set<string>();
  const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : 1));
  let total = 0;
  const prepared = sorted.map((entry) => {
    if (!isPortableZipPath(entry.path)) fail('invalid_path');
    const key = entry.path.toLowerCase();
    if (seen.has(key)) fail('duplicate_path');
    seen.add(key);
    if (entry.bytes.byteLength > ZIP_MAX_ENTRY_BYTES) fail('entry_size_limit');
    total += entry.bytes.byteLength;
    if (total > ZIP_MAX_TOTAL_BYTES) fail('total_size_limit');
    const name = Buffer.from(entry.path, 'utf8');
    const body = Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
    return { name, body, crc: crc32(entry.bytes) };
  });

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of prepared) {
    const header = Buffer.alloc(30);
    writeUInt32(header, LOCAL_SIGNATURE, 0);
    writeUInt16(header, 20, 4); // version needed
    writeUInt16(header, 0x0800, 6); // flags: 文件名按 UTF-8 编码（bit11）
    writeUInt16(header, METHOD_STORED, 8);
    writeUInt16(header, DOS_TIME, 10);
    writeUInt16(header, DOS_DATE, 12);
    writeUInt32(header, entry.crc, 14);
    writeUInt32(header, entry.body.byteLength, 18);
    writeUInt32(header, entry.body.byteLength, 22);
    writeUInt16(header, entry.name.byteLength, 26);
    writeUInt16(header, 0, 28); // extra length
    localParts.push(header, entry.name, entry.body);

    const central = Buffer.alloc(46);
    writeUInt32(central, CENTRAL_SIGNATURE, 0);
    writeUInt16(central, 20, 4); // version made by
    writeUInt16(central, 20, 6); // version needed
    writeUInt16(central, 0x0800, 8); // flags
    writeUInt16(central, METHOD_STORED, 10);
    writeUInt16(central, DOS_TIME, 12);
    writeUInt16(central, DOS_DATE, 14);
    writeUInt32(central, entry.crc, 16);
    writeUInt32(central, entry.body.byteLength, 20);
    writeUInt32(central, entry.body.byteLength, 24);
    writeUInt16(central, entry.name.byteLength, 28);
    writeUInt16(central, 0, 30); // extra
    writeUInt16(central, 0, 32); // comment
    writeUInt16(central, 0, 34); // disk start
    writeUInt16(central, 0, 36); // internal attrs
    writeUInt32(central, 0, 38); // external attrs
    writeUInt32(central, offset, 42); // local header offset
    centralParts.push(central, entry.name);

    offset += 30 + entry.name.byteLength + entry.body.byteLength;
  }

  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(EOCD_MIN_BYTES);
  writeUInt32(end, EOCD_SIGNATURE, 0);
  writeUInt16(end, 0, 4); // disk number
  writeUInt16(end, 0, 6); // disk with central directory
  writeUInt16(end, prepared.length, 8);
  writeUInt16(end, prepared.length, 10);
  writeUInt32(end, centralBytes.byteLength, 12);
  writeUInt32(end, offset, 16);
  writeUInt16(end, 0, 20); // comment length

  return Buffer.concat([...localParts, centralBytes, end]);
};

// ——————————————————————————— 读取 ———————————————————————————

export interface ZipReadEntry {
  path: string;
  bytes: Uint8Array;
}

const decodeName = (name: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(name);
  } catch {
    return fail('invalid_filename_encoding');
  }
};

/** 从尾部定位 EOCD；注释长度必须与实际剩余字节一致，避免把注释里的伪签名当目录。 */
const findEndOfCentralDirectory = (buffer: Buffer): number => {
  if (buffer.byteLength < EOCD_MIN_BYTES) fail('truncated');
  const earliest = Math.max(0, buffer.byteLength - EOCD_MIN_BYTES - EOCD_MAX_COMMENT);
  for (let index = buffer.byteLength - EOCD_MIN_BYTES; index >= earliest; index -= 1) {
    if (buffer.readUInt32LE(index) !== EOCD_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(index + 20);
    if (index + EOCD_MIN_BYTES + commentLength === buffer.byteLength) return index;
  }
  return fail('end_of_central_directory_missing');
};

/** 解析并逐条校验归档；任何偏移/长度/摘要不一致都拒绝，不返回部分结果。 */
export const readZip = (input: Uint8Array): ZipReadEntry[] => {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const eocd = findEndOfCentralDirectory(buffer);
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0)
    fail('multi_disk_unsupported');
  const total = buffer.readUInt16LE(eocd + 10);
  if (buffer.readUInt16LE(eocd + 8) !== total) fail('entry_count_mismatch');
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (total === 0) fail('empty_archive');
  if (total > ZIP_MAX_ENTRIES) fail('entry_limit');
  if (centralOffset + centralSize > eocd) fail('central_directory_out_of_range');

  const entries: ZipReadEntry[] = [];
  const seen = new Set<string>();
  const regions: Array<{ start: number; end: number }> = [];
  let totalBytes = 0;
  let cursor = centralOffset;
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > centralOffset + centralSize) fail('central_directory_truncated');
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) fail('central_header_signature');
    const flags = buffer.readUInt16LE(cursor + 8);
    if ((flags & 0x0001) !== 0) fail('encrypted_unsupported');
    const method = buffer.readUInt16LE(cursor + 10);
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) fail('unsupported_compression');
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (buffer.readUInt16LE(cursor + 34) !== 0) fail('multi_disk_unsupported');
    if (cursor + 46 + nameLength + extraLength + commentLength > centralOffset + centralSize)
      fail('central_directory_truncated');
    const name = decodeName(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) fail('directory_entries_unsupported');
    if (!isPortableZipPath(name)) fail('invalid_path');
    const key = name.toLowerCase();
    if (seen.has(key)) fail('duplicate_path');
    seen.add(key);
    if (uncompressedSize > ZIP_MAX_ENTRY_BYTES) fail('entry_size_limit');
    if (method === METHOD_STORED && compressedSize !== uncompressedSize) fail('size_mismatch');
    if (totalBytes + uncompressedSize > ZIP_MAX_TOTAL_BYTES) fail('total_size_limit');

    // 用本地头的实际名字/额外字段长度计算数据起点，不信任中央目录里的重复字段。
    if (localOffset + 30 > centralOffset) fail('local_header_out_of_range');
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) fail('local_header_signature');
    if (
      buffer.readUInt16LE(localOffset + 6) !== flags ||
      buffer.readUInt16LE(localOffset + 8) !== method
    )
      fail('local_header_mismatch');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > centralOffset) fail('entry_data_out_of_range');
    const localName = decodeName(
      buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    if (!isPortableZipPath(localName) || localName !== name) fail('local_header_mismatch');
    if (
      (flags & 0x0008) === 0 &&
      (buffer.readUInt32LE(localOffset + 14) !== crc ||
        buffer.readUInt32LE(localOffset + 18) !== compressedSize ||
        buffer.readUInt32LE(localOffset + 22) !== uncompressedSize)
    )
      fail('local_header_mismatch');
    const region = { start: localOffset, end: dataStart + compressedSize };
    if (regions.some((prior) => region.start < prior.end && region.end > prior.start))
      fail('entry_overlap');
    regions.push(region);
    if (compressedSize > 0 && uncompressedSize / compressedSize > ZIP_MAX_RATIO)
      fail('compression_ratio_limit');

    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let bytes: Uint8Array;
    if (method === METHOD_DEFLATE) {
      if (compressedSize === 0) fail('invalid_deflate_stream');
      try {
        // 声明只能收紧分配上限。伪造小长度的流必须在扩张时拒绝，不能先分配 1 GiB 再核长度。
        bytes = new Uint8Array(
          inflateRawSync(raw, {
            maxOutputLength: Math.max(
              1,
              Math.min(uncompressedSize, ZIP_MAX_ENTRY_BYTES, ZIP_MAX_TOTAL_BYTES - totalBytes),
            ),
          }),
        );
      } catch {
        return fail('invalid_deflate_stream');
      }
    } else {
      bytes = new Uint8Array(raw);
    }
    if (bytes.byteLength !== uncompressedSize) fail('size_mismatch');
    if (crc32(bytes) !== crc) fail('crc_mismatch');

    totalBytes += bytes.byteLength;
    if (totalBytes > ZIP_MAX_TOTAL_BYTES) fail('total_size_limit');
    entries.push({ path: name, bytes });
  }
  if (cursor !== centralOffset + centralSize) fail('central_directory_size_mismatch');
  return entries;
};
