import { z } from 'zod';
import { inflateSync } from 'node:zlib';
import {
  mediaGenerationCommandSchema,
  zeroMediaUsage,
  type MediaFailureKind,
  type MediaGenerationCommandDto,
  type MediaTaskUsageDto,
  type ModelConnectionInput,
} from '@sew/study-contracts';

export type CompatibleMediaConnectionInput = ModelConnectionInput & {
  readonly baseUrl: string;
  readonly apiKey: string;
};

export interface MediaProviderOutcome {
  dispatched: boolean;
  ok: boolean;
  failureKind: MediaFailureKind | null;
  products: Array<{ bytes: Uint8Array; mime: string; durationSeconds: number | null }>;
  usage: MediaTaskUsageDto | null;
  usageMeasurement: 'actual' | 'estimated' | 'unknown';
  providerJobId?: string;
  elapsedMs: number;
  message: string;
}

export interface MediaProviderOptions {
  signal?: AbortSignal;
  audio?: { bytes: Uint8Array; mime: string };
}

const MAX_PRODUCT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const nullableNumber = z.number().finite().nonnegative().nullable().optional();
const usageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    type: z.string().optional(),
    seconds: nullableNumber,
  })
  .optional();
const imageSchema = z.object({
  data: z
    .array(z.object({ b64_json: z.string().min(4), url: z.string().optional() }))
    .min(1)
    .max(16),
  usage: usageSchema,
});
const transcriptionSchema = z.object({
  text: z.string().trim().min(1).max(100_000),
  duration: nullableNumber,
  usage: usageSchema,
});
const videoSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  status: z.enum(['queued', 'in_progress', 'completed', 'failed', 'cancelled', 'expired']),
  seconds: z
    .union([z.number().finite().positive().max(600), z.string().regex(/^\d+(\.\d+)?$/)])
    .optional(),
  usage: usageSchema,
});

export class MediaProviderFailure extends Error {
  constructor(
    public readonly kind: MediaFailureKind,
    message: string,
  ) {
    super(message);
  }
}

const invalid = (): never => {
  throw new MediaProviderFailure('provider_error', '媒体服务返回无效、空白或超限的产物');
};
const ascii = (bytes: Uint8Array, start: number, length: number): string =>
  Buffer.from(bytes.subarray(start, start + length)).toString('ascii');

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
};

/** Full PNG framing and bounded decompression, including Adam7 scanline sizes. */
const validPng = (b: Buffer): boolean => {
  if (b.length < 57 || !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return false;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bits = 0;
  let color = -1;
  let interlace = 0;
  let palette = false;
  let ended = false;
  let dataEnded = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= b.length) {
    const size = b.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > b.length) return false;
    const tag = ascii(b, offset + 4, 4);
    if (
      !/^[A-Za-z]{4}$/.test(tag) ||
      crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4)
    )
      return false;
    if (offset === 8 && tag !== 'IHDR') return false;
    if (tag === 'IHDR') {
      if (offset !== 8 || size !== 13) return false;
      width = b.readUInt32BE(offset + 8);
      height = b.readUInt32BE(offset + 12);
      bits = b[offset + 16]!;
      color = b[offset + 17]!;
      interlace = b[offset + 20]!;
      const depths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !width ||
        !height ||
        width > 4096 ||
        height > 4096 ||
        !depths[color]?.includes(bits) ||
        b[offset + 18] !== 0 ||
        b[offset + 19] !== 0 ||
        interlace > 1
      )
        return false;
    } else if (tag === 'PLTE') {
      if (compressed.length || palette || !size || size % 3 || size > 768) return false;
      palette = true;
    } else if (tag === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) return false;
      compressed.push(b.subarray(offset + 8, end - 4));
    } else if (tag === 'IEND') {
      if (size !== 0 || end !== b.length || !compressed.length) return false;
      ended = true;
      break;
    } else {
      if (tag[0] === tag[0]!.toUpperCase()) return false;
      if (compressed.length) dataEnded = true;
    }
    offset = end;
  }
  if (!ended) return false;
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const cols = width > x! ? Math.ceil((width - x!) / dx!) : 0;
    return {
      bytes: Math.ceil((cols * channels[color]! * bits) / 8),
      count: cols && height > y! ? Math.ceil((height - y!) / dy!) : 0,
    };
  });
  const expected = rows.reduce((sum, row) => sum + (row.bytes + 1) * row.count, 0);
  if (!expected || expected > 64 * 1024 * 1024) return false;
  try {
    const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
    if (pixels.length !== expected) return false;
    let at = 0;
    for (const row of rows)
      for (let index = 0; index < row.count; index++) {
        if (pixels[at]! > 4) return false;
        at += row.bytes + 1;
      }
    return true;
  } catch {
    return false;
  }
};

interface Mp4Box {
  type: string;
  start: number;
  payload: number;
  end: number;
  children: Mp4Box[];
}
const validMp4 = (b: Buffer): boolean => {
  let count = 0;
  const containers = new Set([
    'moov',
    'trak',
    'mdia',
    'minf',
    'stbl',
    'edts',
    'dinf',
    'mvex',
    'moof',
    'traf',
  ]);
  const parse = (start: number, end: number, depth: number): Mp4Box[] | null => {
    if (depth > 12) return null;
    const boxes: Mp4Box[] = [];
    for (let at = start; at < end;) {
      if (at + 8 > end || ++count > 10_000) return null;
      const short = b.readUInt32BE(at);
      const header = short === 1 ? 16 : 8;
      if (at + header > end) return null;
      const long = short === 1 ? b.readBigUInt64BE(at + 8) : BigInt(short || end - at);
      if (long > BigInt(end - at) || long < BigInt(header)) return null;
      const next = at + Number(long);
      const type = b.toString('latin1', at + 4, at + 8);
      const children = containers.has(type) ? parse(at + header, next, depth + 1) : [];
      if (children === null) return null;
      boxes.push({ type, start: at, payload: at + header, end: next, children });
      at = next;
    }
    return boxes;
  };
  const boxes = parse(0, b.length, 0);
  if (!boxes) return false;
  const ftyp = boxes.find((box) => box.type === 'ftyp');
  const moov = boxes.find((box) => box.type === 'moov');
  const mdats = boxes.filter((box) => box.type === 'mdat' && box.end > box.payload);
  if (
    !ftyp ||
    !moov ||
    !mdats.length ||
    ftyp.end - ftyp.payload < 8 ||
    (ftyp.end - ftyp.payload) % 4 ||
    !['isom', 'iso2', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'].includes(
      ascii(b, ftyp.payload, 4),
    )
  )
    return false;
  const child = (box: Mp4Box | undefined, type: string): Mp4Box | undefined =>
    box?.children.find((value) => value.type === type);
  const mvhd = child(moov, 'mvhd');
  if (!mvhd || mvhd.end - mvhd.payload < (b[mvhd.payload] === 1 ? 112 : 100)) return false;
  const fragmented = boxes.some(
    (box) =>
      box.type === 'moof' &&
      box.children.some(
        (traf) => traf.type === 'traf' && child(traf, 'tfhd') && child(traf, 'trun'),
      ),
  );
  for (const track of moov.children.filter((box) => box.type === 'trak')) {
    const mdia = child(track, 'mdia');
    const hdlr = child(mdia, 'hdlr');
    if (!hdlr || hdlr.end - hdlr.payload < 24 || ascii(b, hdlr.payload + 8, 4) !== 'vide') continue;
    const tkhd = child(track, 'tkhd');
    const mdhd = child(mdia, 'mdhd');
    const stbl = child(child(mdia, 'minf'), 'stbl');
    const stsd = child(stbl, 'stsd');
    const stsz = child(stbl, 'stsz');
    if (
      !tkhd ||
      tkhd.end - tkhd.payload < 84 ||
      !mdhd ||
      mdhd.end - mdhd.payload < 24 ||
      !stsd ||
      stsd.end - stsd.payload < 94 ||
      b.readUInt32BE(stsd.payload + 4) < 1 ||
      !stsz ||
      stsz.end - stsz.payload < 12
    )
      return false;
    const entry = stsd.payload + 8;
    const size = b.readUInt32BE(entry);
    if (
      size < 86 ||
      entry + size > stsd.end ||
      !['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'vp09', 'av01'].includes(ascii(b, entry + 4, 4)) ||
      !b.readUInt16BE(entry + 32) ||
      !b.readUInt16BE(entry + 34)
    )
      return false;
    const sampleSize = b.readUInt32BE(stsz.payload + 4);
    const samples = b.readUInt32BE(stsz.payload + 8);
    if (!samples) return fragmented;
    if (!sampleSize && stsz.end - stsz.payload !== 12 + samples * 4) return false;
    const stco = child(stbl, 'stco') ?? child(stbl, 'co64');
    if (!stco || stco.end - stco.payload < 8) return false;
    const chunks = b.readUInt32BE(stco.payload + 4);
    const stride = stco.type === 'co64' ? 8 : 4;
    if (!chunks || stco.end - stco.payload !== 8 + chunks * stride) return false;
    for (let index = 0; index < chunks; index++) {
      const at = stco.payload + 8 + index * stride;
      const position = stride === 8 ? b.readBigUInt64BE(at) : BigInt(b.readUInt32BE(at));
      if (!mdats.some((box) => position >= BigInt(box.payload) && position < BigInt(box.end)))
        return false;
    }
    return true;
  }
  return false;
};

const validWav = (b: Buffer): boolean => {
  if (
    b.length < 44 ||
    ascii(b, 0, 4) !== 'RIFF' ||
    ascii(b, 8, 4) !== 'WAVE' ||
    b.readUInt32LE(4) + 8 !== b.length
  )
    return false;
  let format = false;
  let data = false;
  let offset = 12;
  for (; offset + 8 <= b.length;) {
    const size = b.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > b.length) return false;
    const tag = ascii(b, offset, 4);
    if (tag === 'fmt ') {
      if (size < 16) return false;
      format =
        b.readUInt16LE(offset + 8) > 0 &&
        b.readUInt16LE(offset + 10) > 0 &&
        b.readUInt32LE(offset + 12) > 0 &&
        b.readUInt32LE(offset + 16) > 0 &&
        b.readUInt16LE(offset + 20) > 0;
    }
    if (tag === 'data') data = size > 0;
    offset = end + (size % 2);
  }
  return format && data && offset === b.length;
};

const validMp3 = (b: Buffer): boolean => {
  let offset = 0;
  if (b.length >= 10 && ascii(b, 0, 3) === 'ID3') {
    if (b[3]! < 2 || b[3]! > 4 || b.subarray(6, 10).some((value) => value >= 128)) return false;
    offset = 10 + (b[6]! << 21) + (b[7]! << 14) + (b[8]! << 7) + b[9]! + (b[5]! & 0x10 ? 10 : 0);
  }
  let frames = 0;
  while (offset + 4 <= b.length) {
    if (frames && b.length - offset === 128 && ascii(b, offset, 3) === 'TAG') return true;
    if (b[offset] !== 0xff || (b[offset + 1]! & 0xe0) !== 0xe0) return false;
    const version = (b[offset + 1]! >>> 3) & 3;
    const layer = (b[offset + 1]! >>> 1) & 3;
    const bitrateIndex = b[offset + 2]! >>> 4;
    const sampleIndex = (b[offset + 2]! >>> 2) & 3;
    if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || sampleIndex === 3)
      return false;
    const rates =
      version === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const sampleRate =
      [44100, 48000, 32000][sampleIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const size =
      Math.floor(((version === 3 ? 144 : 72) * rates[bitrateIndex]! * 1000) / sampleRate) +
      ((b[offset + 2]! >>> 1) & 1);
    if (size < 24 || offset + size > b.length) return false;
    offset += size;
    frames++;
  }
  return frames > 0 && offset === b.length;
};

const validJpeg = (b: Buffer): boolean => {
  if (b.length < 20 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  let at = 2;
  let frame = false;
  let scan = false;
  const sof = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  while (at < b.length) {
    if (b[at++] !== 0xff) return false;
    while (b[at] === 0xff) at++;
    if (at >= b.length) return false;
    const marker = b[at++]!;
    if (marker === 0xd9) return frame && scan && at === b.length;
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || at + 2 > b.length)
      return false;
    const size = b.readUInt16BE(at);
    if (size < 2 || at + size > b.length) return false;
    if (sof.has(marker)) {
      if (
        size < 8 ||
        !b.readUInt16BE(at + 3) ||
        !b.readUInt16BE(at + 5) ||
        size !== 8 + 3 * b[at + 7]!
      )
        return false;
      frame = true;
    }
    at += size;
    if (marker === 0xda) {
      if (!frame || size < 6) return false;
      const start = at;
      while (at + 1 < b.length) {
        if (b[at] !== 0xff) {
          at++;
          continue;
        }
        if (b[at + 1] === 0 || (b[at + 1]! >= 0xd0 && b[at + 1]! <= 0xd7)) {
          at += 2;
          continue;
        }
        break;
      }
      if (at === start) return false;
      scan = true;
    }
  }
  return false;
};

const validWebp = (b: Buffer): boolean => {
  if (
    b.length < 26 ||
    ascii(b, 0, 4) !== 'RIFF' ||
    ascii(b, 8, 4) !== 'WEBP' ||
    b.readUInt32LE(4) + 8 !== b.length
  )
    return false;
  let image = false;
  let at = 12;
  while (at + 8 <= b.length) {
    const tag = ascii(b, at, 4);
    const size = b.readUInt32LE(at + 4);
    const data = at + 8;
    if (data + size > b.length) return false;
    if (tag === 'VP8 ') {
      if (
        size < 11 ||
        b[data]! & 1 ||
        b[data + 3] !== 0x9d ||
        b[data + 4] !== 1 ||
        b[data + 5] !== 0x2a ||
        !(b.readUInt16LE(data + 6) & 0x3fff) ||
        !(b.readUInt16LE(data + 8) & 0x3fff)
      )
        return false;
      image = true;
    } else if (tag === 'VP8L') {
      if (size < 6 || b[data] !== 0x2f || b[data + 4]! & 0xe0) return false;
      image = true;
    }
    at = data + size + (size % 2);
  }
  return image && at === b.length;
};

/** Sniff bytes, never trust the provider Content-Type alone. */
export const mediaMime = (bytes: Uint8Array): string | null => {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (validPng(b)) return 'image/png';
  if (validJpeg(b)) return 'image/jpeg';
  if (validWebp(b)) return 'image/webp';
  if (validWav(b)) return 'audio/wav';
  if (validMp3(b)) return 'audio/mpeg';
  if (validMp4(b)) return 'video/mp4';
  return null;
};

/** Only implemented protocol options are admitted: unsupported reference assets never silently disappear. */
export const validateMediaProviderCommand = (
  value: MediaGenerationCommandDto,
  input: CompatibleMediaConnectionInput,
  options: MediaProviderOptions,
): MediaGenerationCommandDto => {
  const parsed = mediaGenerationCommandSchema.safeParse(value);
  if (!parsed.success)
    throw new MediaProviderFailure('provider_error', '媒体命令格式无效，已拒绝派发');
  const command = parsed.data;
  if (
    (command.kind === 'image' && command.workflowLocation === 'local') ||
    (command.kind === 'asr' && command.engine !== 'remote')
  ) {
    throw new MediaProviderFailure('local_engine_unavailable', '尚未接入本地媒体引擎');
  }
  if (command.provider !== 'openai-compatible') {
    throw new MediaProviderFailure('provider_not_configured', '该媒体 provider 尚未接入');
  }
  if (
    (command.kind === 'image' &&
      (command.referenceAssetId ||
        command.negativePrompt ||
        command.seed != null ||
        command.steps !== 20 ||
        command.guidance !== 7 ||
        command.count > 10)) ||
    (command.kind === 'video' && (command.firstFrameAssetId || command.negativePrompt))
  ) {
    throw new MediaProviderFailure('provider_error', '当前兼容接口不支持该媒体参数，请调整后重试');
  }
  if (command.kind === 'video') {
    // Official Sora/Videos API retired 2026-09-24. Third-party compatible endpoints may still implement it.
    if (new URL(input.baseUrl).hostname === 'api.openai.com') {
      throw new MediaProviderFailure(
        'provider_error',
        'OpenAI 官方 Videos API 已停用，请选择支持视频协议的兼容服务',
      );
    }
    if (command.aspectRatio && !['16:9', '9:16'].includes(command.aspectRatio)) {
      throw new MediaProviderFailure('provider_error', '当前视频接口仅支持 16:9 或 9:16');
    }
  }
  if (command.kind === 'asr') {
    if (!command.microphoneGranted)
      throw new MediaProviderFailure('permission_denied', '未获得录音授权');
    const audio = options.audio;
    if (!audio || !audio.bytes.byteLength || audio.bytes.byteLength > MAX_PRODUCT_BYTES) {
      throw new MediaProviderFailure('provider_error', '缺少有效且大小合规的音频资产');
    }
    const mime = mediaMime(audio.bytes);
    if (!['audio/wav', 'audio/mpeg'].includes(mime ?? '') || audio.mime !== mime) {
      throw new MediaProviderFailure(
        'provider_error',
        '音频资产字节与格式不一致，仅支持 WAV 或 MP3',
      );
    }
  }
  return command;
};

/** Race even a transport that ignores AbortSignal; late responses are discarded. */
const abortable = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise((resolve, reject) => {
    const abort = () => reject(new MediaProviderFailure('cancelled', '媒体调用已取消'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });

const waitForPoll = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new MediaProviderFailure('cancelled', '媒体调用已取消'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });

const readBytes = async (response: Response, signal: AbortSignal): Promise<Uint8Array> => {
  if (!response.body) return invalid();
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (signal.aborted) throw new MediaProviderFailure('cancelled', '媒体调用已取消');
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PRODUCT_BYTES) return invalid();
      chunks.push(next.value);
    }
    if (!size) return invalid();
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
  }
};

const usageOf = (usage: z.infer<typeof usageSchema>): MediaTaskUsageDto => ({
  ...zeroMediaUsage(),
  tokens: {
    promptTokens: usage?.input_tokens ?? null,
    completionTokens: usage?.output_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
  },
});

type ProviderResult = Pick<MediaProviderOutcome, 'products' | 'usage' | 'usageMeasurement'>;

/** Private credential consumer. Callers must complete project/run/budget admission before invoking it.
 * Protocol sources: developers.openai.com/api/reference/resources/{images,audio} and
 * developers.openai.com/api/docs/guides/video-generation (historical compatible protocol).
 */
export const executeMediaProvider = async ({
  command,
  input,
  options,
  fetcher,
  signal,
  readJson,
  onDispatch,
  onJob,
}: {
  command: MediaGenerationCommandDto;
  input: CompatibleMediaConnectionInput;
  options: MediaProviderOptions;
  fetcher: typeof fetch;
  signal: AbortSignal;
  readJson: (
    response: Response | Request,
    limit?: number,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  onDispatch: () => void;
  onJob: (id: string) => void;
}): Promise<ProviderResult> => {
  const request = async (path: string, body?: BodyInit): Promise<Response> => {
    if (signal.aborted) throw new MediaProviderFailure('cancelled', '媒体调用已取消');
    onDispatch();
    const response = await abortable(
      fetcher(`${input.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal,
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      })
        .then(async (response) => {
          if (signal.aborted) {
            await response.body?.cancel().catch(() => undefined);
            throw new MediaProviderFailure('cancelled', '媒体调用已取消');
          }
          return response;
        })
        .catch((error: unknown) => {
          if (error instanceof MediaProviderFailure) throw error;
          throw new MediaProviderFailure(
            'no_connection',
            '媒体网络连接失败，调用结果未知，请检查网络',
          );
        }),
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new MediaProviderFailure(
        'provider_error',
        `媒体服务返回 HTTP ${response.status}，请核对接口、模型及额度`,
      );
    }
    return response;
  };
  const json = async (response: Response, limit = 128 * 1024): Promise<unknown> =>
    abortable(readJson(response, limit, signal), signal);
  const model = command.model ?? input.model;
  if (command.kind === 'image') {
    const response = await request(
      '/images/generations',
      JSON.stringify({
        model,
        prompt: command.prompt,
        n: command.count,
        size: `${command.width}x${command.height}`,
        // GPT image models always return base64 and reject legacy response_format.
        ...(/^gpt-image-/.test(model) ? { output_format: 'png' } : { response_format: 'b64_json' }),
      }),
    );
    const parsed = imageSchema.safeParse(await json(response, MAX_TOTAL_BYTES));
    if (!parsed.success || parsed.data.data.length !== command.count) return invalid();
    let total = 0;
    const products = parsed.data.data.map((item) => {
      // No remote URL downloads, permissive Buffer base64 parsing or unbounded allocations.
      if (
        item.url ||
        item.b64_json.length > Math.ceil(MAX_PRODUCT_BYTES / 3) * 4 ||
        item.b64_json.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(item.b64_json)
      )
        return invalid();
      const bytes = Buffer.from(item.b64_json, 'base64');
      if (
        bytes.toString('base64') !== item.b64_json ||
        !bytes.byteLength ||
        bytes.byteLength > MAX_PRODUCT_BYTES
      )
        return invalid();
      total += bytes.byteLength;
      if (total > MAX_TOTAL_BYTES) return invalid();
      const mime = mediaMime(bytes);
      if (!mime?.startsWith('image/')) return invalid();
      return { bytes, mime, durationSeconds: null };
    });
    return {
      products,
      usage: { ...usageOf(parsed.data.usage), images: products.length },
      usageMeasurement: 'actual',
    };
  }
  if (command.kind === 'tts') {
    const bytes = await readBytes(
      await request(
        '/audio/speech',
        JSON.stringify({
          model,
          input: command.text,
          voice: command.voiceId.startsWith('voice_') ? { id: command.voiceId } : command.voiceId,
          response_format: 'wav',
          // playbackRate affects the UI player, never the generated speech.
        }),
      ),
      signal,
    );
    const mime = mediaMime(bytes);
    if (!mime || !['audio/wav', 'audio/mpeg'].includes(mime)) return invalid();
    return {
      products: [{ bytes, mime, durationSeconds: null }],
      usage: { ...usageOf(undefined), characters: command.text.length, audioSeconds: null },
      usageMeasurement: 'estimated',
    };
  }
  if (command.kind === 'asr') {
    const audio = options.audio!;
    const body = new FormData();
    body.append('model', model);
    body.append('response_format', 'json');
    if (command.locale) body.append('language', command.locale.split(/[-_]/)[0]!);
    body.append(
      'file',
      new Blob([Uint8Array.from(audio.bytes)], { type: audio.mime }),
      audio.mime === 'audio/wav' ? 'recording.wav' : 'recording.mp3',
    );
    const parsed = transcriptionSchema.safeParse(
      await json(await request('/audio/transcriptions', body), 512 * 1024),
    );
    if (!parsed.success || (input.apiKey.length > 0 && parsed.data.text.includes(input.apiKey)))
      return invalid();
    const seconds =
      parsed.data.usage?.type === 'duration' ? parsed.data.usage.seconds : parsed.data.duration;
    const actual = typeof seconds === 'number' && seconds > 0;
    return {
      products: [
        {
          bytes: new TextEncoder().encode(parsed.data.text),
          mime: 'text/plain',
          durationSeconds: actual ? seconds : null,
        },
      ],
      usage: { ...usageOf(parsed.data.usage), asrSeconds: actual ? seconds : command.audioSeconds },
      usageMeasurement: actual ? 'actual' : 'estimated',
    };
  }
  const body = new FormData();
  body.append('model', model);
  body.append('prompt', command.prompt);
  body.append('seconds', String(command.durationSeconds));
  body.append('size', command.aspectRatio === '9:16' ? '720x1280' : '1280x720');
  const first = videoSchema.safeParse(await json(await request('/videos', body)));
  if (!first.success || (input.apiKey.length > 0 && first.data.id.includes(input.apiKey)))
    return invalid();
  const id = first.data.id;
  onJob(id);
  let job = first.data;
  let polls = 0;
  while (job.status === 'queued' || job.status === 'in_progress') {
    if (polls >= command.poll.maxPolls)
      throw new MediaProviderFailure(
        'poll_limit_exceeded',
        '视频查询次数已用满，远端任务可能仍在执行',
      );
    await waitForPoll(command.poll.intervalMs, signal);
    const next = videoSchema.safeParse(
      await json(await request(`/videos/${encodeURIComponent(id)}`)),
    );
    if (!next.success || next.data.id !== id) return invalid();
    job = next.data;
    polls++;
  }
  if (job.status !== 'completed')
    throw new MediaProviderFailure(
      job.status === 'cancelled' ? 'cancelled' : 'provider_error',
      '视频服务未完成生成',
    );
  const bytes = await readBytes(await request(`/videos/${encodeURIComponent(id)}/content`), signal);
  if (mediaMime(bytes) !== 'video/mp4') return invalid();
  const seconds = job.seconds !== undefined ? Number(job.seconds) : null;
  const actual = seconds !== null && Number.isFinite(seconds) && seconds > 0 && seconds <= 600;
  return {
    products: [{ bytes, mime: 'video/mp4', durationSeconds: actual ? seconds : null }],
    usage: { ...usageOf(job.usage), videoSeconds: actual ? seconds : command.durationSeconds },
    usageMeasurement: actual ? 'actual' : 'estimated',
  };
};
