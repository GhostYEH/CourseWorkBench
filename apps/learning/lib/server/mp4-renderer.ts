import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Mp4RenderPlan } from '@sew/study-domain';
import { decodeJson } from '@sew/study-storage';
import { z } from 'zod';

const MAX_SCENES = 48;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_DURATION_MS = 30 * 60 * 1000;
const MAX_PIXELS = 1920 * 1080;
const MAX_FPS = 30;
const MAX_RUNTIME_BINARY_BYTES = 600 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_RESUMED_FRAME_BYTES = 256 * 1024 * 1024;
const PROCESS_OUTPUT_LIMIT = 96 * 1024;
const PROCESS_TIMEOUT_MS = 120_000;
const RENDER_TIMEOUT_MS = 15 * 60_000;
const ENCODE_TIMEOUT_MS = 20 * 60_000;

export interface Mp4RuntimeOptions {
  /** Explicit executable locations. Environment variables are used when omitted. */
  readonly chromiumPath?: string;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly signal?: AbortSignal;
}

export interface Mp4RuntimeFact {
  readonly kind: 'chromium' | 'ffmpeg' | 'ffprobe';
  readonly path: string | null;
  readonly version: string | null;
  readonly sha256: string | null;
  readonly available: boolean;
  readonly reason: string;
}

export interface Mp4RuntimeInspection {
  readonly ready: boolean;
  readonly runtimes: readonly Mp4RuntimeFact[];
  readonly gaps: readonly string[];
}

export interface Mp4BoundedAsset {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly sha256: string;
}

export interface Mp4PublicDocument {
  readonly scenes: readonly {
    readonly id: string;
    readonly type: string;
    readonly title: string;
    readonly content: unknown;
  }[];
}

export interface Mp4RenderOptions extends Mp4RuntimeOptions {
  readonly signal: AbortSignal;
  /** Existing verified PNG segment frames, indexed by plan segment. */
  readonly resumeSegments?: ReadonlyMap<number, Uint8Array>;
  /** Called only with a newly captured, complete PNG frame. */
  readonly onSegment?: (index: number, png: Uint8Array) => void | Promise<void>;
  readonly onStage?: (stage: 'capturing' | 'encoding') => void | Promise<void>;
  readonly timeoutMs?: number;
}

export interface Mp4RenderEvidence {
  readonly mode: 'closed-scene-projection';
  readonly interactionPreserved: false;
  readonly audioPresent: false;
  readonly container: string;
  readonly videoCodec: string;
  readonly pixelFormat: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly frameCount: number;
  readonly decodedFrames: number;
  readonly ffprobeVerified: true;
  readonly fullDecodeVerified: true;
}

export interface Mp4RenderResult {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteLength: number;
  readonly playable: true;
  readonly runtimes: Mp4RuntimeInspection;
  readonly evidence: Mp4RenderEvidence;
  readonly reusedSegments: number;
  readonly capturedSegments: number;
}

export class Mp4RenderError extends Error {
  constructor(
    readonly code:
      | 'runtime-missing'
      | 'runtime-mismatch'
      | 'unsupported-scene'
      | 'asset-invalid'
      | 'resource-limit'
      | 'cancelled'
      | 'timeout'
      | 'render-failed'
      | 'encode-failed'
      | 'output-invalid',
    message: string,
  ) {
    super(message);
    this.name = 'Mp4RenderError';
  }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const abortIfNeeded = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Mp4RenderError('cancelled', 'MP4 渲染已取消。');
};

const resolveBinary = async (kind: 'chromium' | 'ffmpeg' | 'ffprobe', explicit?: string) => {
  const configured = explicit ?? process.env[`SEW_${kind.toUpperCase()}_PATH`];
  const candidates = configured
    ? [configured]
    : kind === 'chromium'
      ? [
          process.env['PROGRAMFILES'] &&
            path.join(process.env['PROGRAMFILES'], 'Google/Chrome/Application/chrome.exe'),
          process.env['PROGRAMFILES(X86)'] &&
            path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
          process.env['PROGRAMFILES'] &&
            path.join(process.env['PROGRAMFILES'], 'Microsoft/Edge/Application/msedge.exe'),
        ].filter((value): value is string => Boolean(value))
      : [];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return path.resolve(candidate);
    } catch {
      // Try the next known installation location. No directory scanning is performed.
    }
  }
  if (!configured && kind !== 'chromium') {
    const binaryName = process.platform === 'win32' ? `${kind}.exe` : kind;
    for (const folder of (process.env['PATH'] ?? '').split(path.delimiter)) {
      const candidate = path.join(folder, binaryName);
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // Continue through PATH entries.
      }
    }
  }
  return null;
};

interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const run = (
  executable: string,
  args: readonly string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Mp4RenderError('cancelled', 'MP4 渲染已取消。'));
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string =>
      (current + chunk.toString('utf8')).slice(-PROCESS_OUTPUT_LIMIT);
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);
    const onAbort = () => terminateChild(child);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });

    function terminateChild(child: ReturnType<typeof spawn>): void {
      if (process.platform === 'win32' && child.pid !== undefined) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
          shell: false,
        });
        killer.unref();
      }
      child.kill();
    }
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted)
        return reject(new Mp4RenderError('cancelled', 'MP4 渲染已取消。'));
      if (timedOut) return reject(new Mp4RenderError('timeout', 'MP4 渲染进程超时。'));
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });

const inspectOne = async (
  kind: Mp4RuntimeFact['kind'],
  binary: string | null,
  signal?: AbortSignal,
): Promise<Mp4RuntimeFact> => {
  if (!binary)
    return {
      kind,
      path: null,
      version: null,
      sha256: null,
      available: false,
      reason: `${kind} 未配置或未安装。`,
    };
  try {
    if (signal?.aborted) throw new Mp4RenderError('cancelled', 'MP4 渲染已取消。');
    const info = await stat(binary);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_RUNTIME_BINARY_BYTES)
      throw new Error('运行时二进制文件大小超出 600 MiB 探测上限');
    const [versionResult, digest] = await Promise.all([
      kind === 'chromium' && process.platform === 'win32'
        ? run(
            'powershell.exe',
            [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $info = (Get-Item -LiteralPath $env:SEW_MP4_RUNTIME_PROBE_PATH).VersionInfo; [Console]::WriteLine($info.ProductName + " " + $info.ProductVersion)',
            ],
            {
              signal,
              timeoutMs: 10_000,
              env: { ...process.env, SEW_MP4_RUNTIME_PROBE_PATH: binary },
            },
          )
        : run(binary, [kind === 'chromium' ? '--version' : '-version'], {
            signal,
            timeoutMs: 10_000,
          }),
      (async () => {
        const hash = createHash('sha256');
        const { createReadStream } = await import('node:fs');
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(binary);
          const stopHashing = () =>
            stream.destroy(new Mp4RenderError('cancelled', 'MP4 渲染已取消。'));
          signal?.addEventListener('abort', stopHashing, { once: true });
          stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
          stream.once('error', reject);
          stream.once('end', resolve);
          stream.once('close', () => signal?.removeEventListener('abort', stopHashing));
        });
        return hash.digest('hex');
      })(),
    ]);
    if (versionResult.code !== 0) throw new Error('版本探测退出码非零');
    const output = `${versionResult.stdout}\n${versionResult.stderr}`;
    const firstLine = output.split(/\r?\n/, 1)[0]?.trim() ?? '';
    if (
      !firstLine ||
      (kind === 'chromium' && !/\b\d+(?:\.\d+){1,3}\b/.test(firstLine)) ||
      (kind !== 'chromium' && !/\bversion\s+\S+/i.test(firstLine))
    ) {
      throw new Error('版本探测没有可信产品名和版本号');
    }
    return {
      kind,
      path: binary,
      version: firstLine.slice(0, 200),
      sha256: digest,
      available: true,
      reason: '',
    };
  } catch (error) {
    if (signal?.aborted) throw new Mp4RenderError('cancelled', 'MP4 渲染已取消。');
    return {
      kind,
      path: binary,
      version: null,
      sha256: null,
      available: false,
      reason: `运行时不可用：${error instanceof Error ? error.message : '探测失败'}`,
    };
  }
};

export async function inspectMp4Runtime(
  options: Mp4RuntimeOptions = {},
): Promise<Mp4RuntimeInspection> {
  const paths = await Promise.all([
    resolveBinary('chromium', options.chromiumPath),
    resolveBinary('ffmpeg', options.ffmpegPath),
    resolveBinary('ffprobe', options.ffprobePath),
  ]);
  const runtimes = await Promise.all([
    inspectOne('chromium', paths[0]!, options.signal),
    inspectOne('ffmpeg', paths[1]!, options.signal),
    inspectOne('ffprobe', paths[2]!, options.signal),
  ]);
  const gaps = runtimes
    .filter((runtime) => !runtime.available)
    .map((runtime) => `${runtime.kind}: ${runtime.reason}`);
  return { ready: gaps.length === 0, runtimes, gaps };
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const plain = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    : '';
const safeRichText = (value: string): string => {
  const withoutParagraphShell = value.replace(/<\/?p\b[^>]*>/gi, '');
  return withoutParagraphShell
    .split(/(<\/?(?:b|i|u|sub|sup|br)\s*\/?>)/gi)
    .map((part) => {
      const match = part.match(/^<(\/)?(b|i|u|sub|sup|br)\s*\/?>$/i);
      if (!match) return escapeHtml(part);
      const tag = match[2]!.toLowerCase();
      return tag === 'br' ? '<br>' : `<${match[1] ? '/' : ''}${tag}>`;
    })
    .join('');
};
const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const imagePixelCount = (asset: Mp4BoundedAsset): number => {
  const bytes = Buffer.from(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength);
  let width = 0;
  let height = 0;
  if (
    asset.mediaType === 'image/png' &&
    bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
    bytes.length >= 24
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (asset.mediaType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if ([0xd8, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7].includes(marker)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 7
      ) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else {
    throw new Mp4RenderError('asset-invalid', '图片资源仅接受 MIME 与签名一致的 PNG/JPEG。');
  }
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192)
    throw new Mp4RenderError('asset-invalid', '图片资源尺寸无效或超过 8192 × 8192。');
  return width * height;
};

const publicSceneHtml = (
  scene: Mp4PublicDocument['scenes'][number],
  assets: ReadonlyMap<string, Mp4BoundedAsset>,
  width: number,
  height: number,
): string => {
  if (scene.type !== 'slide' && scene.type !== 'quiz') {
    throw new Mp4RenderError(
      'unsupported-scene',
      `场景「${scene.title}」类型 ${scene.type} 需要交互播放，MP4 线性投影不支持。`,
    );
  }
  const content = scene.content as Record<string, unknown> | null;
  if (!content || typeof content !== 'object' || content['type'] !== scene.type) {
    throw new Mp4RenderError('unsupported-scene', `场景「${scene.title}」的冻结内容结构不完整。`);
  }
  const title = `<h1>${escapeHtml(scene.title)}</h1>`;
  let body = '';
  if (scene.type === 'slide') {
    const canvas = content['canvas'] as Record<string, unknown> | undefined;
    if (!canvas || !Array.isArray(canvas['elements']))
      throw new Mp4RenderError('unsupported-scene', `幻灯片「${scene.title}」缺少正式画布。`);
    const elements = canvas['elements'] as Array<Record<string, unknown>>;
    if (elements.length > 24)
      throw new Mp4RenderError('resource-limit', `幻灯片「${scene.title}」元素数量超限。`);
    const viewport = Math.max(1, Math.min(4000, finite(canvas['viewportSize'], 1000)));
    const requestedRatio = finite(canvas['viewportRatio'], 0.5625);
    const ratio = Math.max(0.1, Math.min(10, requestedRatio));
    const canvasHeight = viewport * ratio;
    const background =
      canvas['theme'] && typeof canvas['theme'] === 'object'
        ? (canvas['theme'] as Record<string, unknown>)['backgroundColor']
        : '#f4f6fb';
    const bg =
      typeof background === 'string' && /^#[0-9a-fA-F]{6}$/.test(background)
        ? background
        : '#f4f6fb';
    const rendered = elements
      .map((element, index) => {
        const left = Math.max(0, Math.min(viewport, finite(element['left'], 0)));
        const top = Math.max(0, Math.min(canvasHeight, finite(element['top'], 0)));
        const elWidth = Math.max(1, Math.min(viewport - left, finite(element['width'], 100)));
        const elHeight = Math.max(1, Math.min(canvasHeight - top, finite(element['height'], 50)));
        const pos = `left:${(left / viewport) * 100}%;top:${(top / canvasHeight) * 100}%;width:${(elWidth / viewport) * 100}%;height:${(elHeight / canvasHeight) * 100}%`;
        if (element['type'] === 'text') {
          const originalText = typeof element['content'] === 'string' ? element['content'] : '';
          if (/\$\$?|\\\[|\\\(|\\frac\b|\\sqrt\b/.test(originalText))
            throw new Mp4RenderError(
              'unsupported-scene',
              `幻灯片「${scene.title}」包含需公式排版运行时的内容。`,
            );
          const style = originalText
            ? (originalText.match(/<p[^>]*style=["']([^"']*)["']/i)?.[1] ?? '')
            : '';
          const safeColor =
            style.match(/(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? '#232323';
          const safeSize = Math.max(
            8,
            Math.min(96, Number(style.match(/font-size\s*:\s*(\d+(?:\.\d+)?)px/i)?.[1] ?? 24)),
          );
          const align = style.match(/text-align\s*:\s*(left|center|right)/i)?.[1] ?? 'left';
          const text = safeRichText(originalText);
          return `<div class="element text" style="${pos};color:${safeColor};font-size:${safeSize}px;text-align:${align}">${text}</div>`;
        }
        if (element['type'] === 'image') {
          const ref = typeof element['src'] === 'string' ? element['src'] : '';
          const asset = assets.get(ref);
          if (!asset || sha256(asset.bytes) !== asset.sha256)
            throw new Mp4RenderError(
              'asset-invalid',
              `幻灯片图片资源 ${index + 1} 未绑定或摘要不符。`,
            );
          const uri = `data:${asset.mediaType};base64,${Buffer.from(asset.bytes).toString('base64')}`;
          return `<img class="element image" style="${pos}" src="${uri}" alt=""/>`;
        }
        throw new Mp4RenderError(
          'unsupported-scene',
          `幻灯片「${scene.title}」包含不支持的正式元素类型。`,
        );
      })
      .join('');
    const contentArea = `<main class="slide" style="background:${bg};aspect-ratio:${viewport}/${canvasHeight}">${rendered}</main>`;
    body = contentArea;
  } else {
    const questions = (content['questions'] ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(questions) || questions.length === 0 || questions.length > 12)
      throw new Mp4RenderError('unsupported-scene', `测验「${scene.title}」缺少可展示题目。`);
    body = `<main class="quiz">${questions
      .map((question) => {
        const prompt = plain(question['question']);
        const options = Array.isArray(question['options'])
          ? (question['options'] as Array<Record<string, unknown>>)
          : [];
        return `<section><h2>${escapeHtml(prompt)}</h2>${options.map((option) => `<p>${escapeHtml(plain(option['label']))}</p>`).join('')}</section>`;
      })
      .join('')}</main>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${width},initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff;color:#232323;font-family:"Microsoft YaHei",Arial,sans-serif}body{padding:${Math.round(height * 0.035)}px}h1{font-size:${Math.round(height * 0.052)}px;margin:0 0 ${Math.round(height * 0.025)}px}.slide{position:relative;width:100%;height:auto;max-height:${Math.round(height * 0.81)}px;overflow:hidden}.element{position:absolute;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}.text{padding:4px;line-height:1.45}.image{object-fit:contain}.quiz section{border:2px solid #d5dbea;border-radius:16px;padding:24px;margin:16px 0}.quiz h2{font-size:${Math.round(height * 0.035)}px}.quiz p{font-size:${Math.round(height * 0.028)}px}</style></head><body>${title}${body}</body></html>`;
};

const readPng = async (file: string): Promise<Uint8Array> => {
  const fileInfo = await stat(file);
  if (!fileInfo.isFile() || fileInfo.size < 100 || fileInfo.size > 20 * 1024 * 1024)
    throw new Mp4RenderError('render-failed', 'Chromium PNG 帧超出文件大小限制。');
  const bytes = await readFile(file);
  assertPngFrame(bytes, undefined, undefined, 'render-failed');
  return bytes;
};

function assertPngFrame(
  bytes: Uint8Array,
  expectedWidth: number | undefined,
  expectedHeight: number | undefined,
  code: 'render-failed' | 'asset-invalid',
): void {
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    png.byteLength < 100 ||
    png.byteLength > 20 * 1024 * 1024 ||
    png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  ) {
    throw new Mp4RenderError(code, '渲染检查点不是有效的有界 PNG 帧。');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_PIXELS ||
    (expectedWidth !== undefined && width !== expectedWidth) ||
    (expectedHeight !== undefined && height !== expectedHeight)
  ) {
    throw new Mp4RenderError(code, 'PNG 帧的实际画幅超出限制或与编码计划不符。');
  }
}

function probeJson(stdout: string): Record<string, unknown> {
  const parsed = decodeJson(stdout, z.record(z.unknown()).nullable(), null, 'mp4_ffprobe');
  if (!parsed.ok || !parsed.value) throw new Mp4RenderError('output-invalid', 'ffprobe 输出无效。');
  return parsed.value;
}

export async function renderMp4(
  plan: Mp4RenderPlan,
  publicDocument: Mp4PublicDocument,
  boundedAssets: ReadonlyMap<string, Mp4BoundedAsset>,
  options: Mp4RenderOptions,
): Promise<Mp4RenderResult> {
  abortIfNeeded(options.signal);
  if (
    plan.segments.length === 0 ||
    plan.segments.length > MAX_SCENES ||
    publicDocument.scenes.length !== plan.segments.length
  )
    throw new Mp4RenderError('resource-limit', '场景数量或文档/计划场景数不符合限制。');
  for (const [index, segment] of plan.segments.entries()) {
    const scene = publicDocument.scenes[index];
    if (!scene || scene.id !== segment.sceneId || scene.type !== segment.sceneKind)
      throw new Mp4RenderError('unsupported-scene', '冻结文档与渲染计划场景顺序不一致。');
    if (scene.type !== 'slide' && scene.type !== 'quiz')
      throw new Mp4RenderError(
        'unsupported-scene',
        `场景「${scene.title}」类型 ${scene.type} 需要交互播放，MP4 线性投影不支持。`,
      );
  }
  if (plan.totalDurationMs > MAX_TOTAL_DURATION_MS || plan.totalDurationMs <= 0)
    throw new Mp4RenderError('resource-limit', '视频计划时长超出 30 分钟运行上限。');
  const { width, height, fps, constantRateFactor } = plan.encoding;
  if (plan.encoding.audio !== null) {
    throw new Mp4RenderError(
      'unsupported-scene',
      '当前投影器没有经过验证的旁白音轨输入，拒绝生成无声替代视频。',
    );
  }
  if (width * height > MAX_PIXELS || fps > MAX_FPS)
    throw new Mp4RenderError('resource-limit', '本机运行时限定为 1080p、30 fps。');
  let totalAssetBytes = 0;
  let totalImagePixels = 0;
  for (const asset of boundedAssets.values()) {
    totalAssetBytes += asset.bytes.byteLength;
    totalImagePixels += imagePixelCount(asset);
    if (totalAssetBytes > MAX_ASSET_BYTES || sha256(asset.bytes) !== asset.sha256)
      throw new Mp4RenderError('asset-invalid', '图片资源超出 32 MiB 或摘要不符。');
    if (totalImagePixels > 120_000_000)
      throw new Mp4RenderError('resource-limit', '解码图片总像素超过 1.2 亿。');
  }
  const renderedPages = plan.segments.map((_, index) =>
    publicSceneHtml(publicDocument.scenes[index]!, boundedAssets, width, height),
  );
  const inspection = await inspectMp4Runtime({ ...options, signal: options.signal });
  if (!inspection.ready) throw new Mp4RenderError('runtime-missing', inspection.gaps.join(' '));
  const runtimeByKind = new Map(inspection.runtimes.map((runtime) => [runtime.kind, runtime]));
  const browser = runtimeByKind.get('chromium')!.path!;
  const ffmpeg = runtimeByKind.get('ffmpeg')!.path!;
  const ffprobe = runtimeByKind.get('ffprobe')!.path!;
  const timeout = Math.min(
    Math.max(options.timeoutMs ?? RENDER_TIMEOUT_MS, 1_000),
    RENDER_TIMEOUT_MS + ENCODE_TIMEOUT_MS,
  );
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'sew-mp4-'));
  const controller = new AbortController();
  const abortForward = () => controller.abort();
  options.signal.addEventListener('abort', abortForward, { once: true });
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    await options.onStage?.('capturing');
    const frames = new Map<number, Uint8Array>();
    let reusedSegments = 0;
    let resumedBytes = 0;
    let capturedBytes = 0;
    for (let index = 0; index < plan.segments.length; index++) {
      abortIfNeeded(controller.signal);
      const reused = options.resumeSegments?.get(index);
      if (reused) {
        assertPngFrame(reused, width, height, 'asset-invalid');
        resumedBytes += reused.byteLength;
        if (resumedBytes > MAX_RESUMED_FRAME_BYTES)
          throw new Mp4RenderError('resource-limit', '恢复 PNG 检查点总量超过 256 MiB。');
        frames.set(index, reused);
        reusedSegments++;
        continue;
      }
      const segment = plan.segments[index]!;
      const scene = publicDocument.scenes[index]!;
      if (scene.id !== segment.sceneId || scene.type !== segment.sceneKind)
        throw new Mp4RenderError('unsupported-scene', '冻结文档与渲染计划场景顺序不一致。');
      const html = renderedPages[index]!;
      const htmlPath = path.join(tempRoot, `scene-${index}.html`);
      const pngPath = path.join(tempRoot, `frame-${index}.png`);
      await writeFile(htmlPath, html, { flag: 'wx' });
      const shot = await run(
        browser,
        [
          '--headless',
          '--disable-gpu',
          '--hide-scrollbars',
          '--disable-background-networking',
          '--disable-sync',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${path.join(tempRoot, `chrome-profile-${index}`)}`,
          '--host-resolver-rules=MAP * ~NOTFOUND',
          `--window-size=${width},${height}`,
          `--screenshot=${pngPath}`,
          pathToFileURL(htmlPath).href,
        ],
        {
          signal: controller.signal,
          timeoutMs: Math.min(PROCESS_TIMEOUT_MS, Math.ceil(timeout / plan.segments.length)),
          cwd: tempRoot,
        },
      );
      if (shot.code !== 0)
        throw new Mp4RenderError(
          'render-failed',
          `Chromium 捕获场景 ${index + 1} 失败：${shot.stderr.slice(-1200)}`,
        );
      const png = await readPng(pngPath);
      capturedBytes += png.byteLength;
      if (capturedBytes + resumedBytes > MAX_RESUMED_FRAME_BYTES)
        throw new Mp4RenderError('resource-limit', 'PNG 检查点累计超过 256 MiB。');
      frames.set(index, png);
      await options.onSegment?.(index, png);
    }
    abortIfNeeded(controller.signal);
    await options.onStage?.('encoding');
    for (const [index, png] of frames)
      await writeFile(path.join(tempRoot, `frame-${index}.png`), png, { flag: 'w' });
    const concat =
      plan.segments
        .map(
          (segment, index) =>
            `file 'frame-${index}.png'\nduration ${(segment.durationMs / 1000).toFixed(3)}`,
        )
        .join('\n') + `\nfile 'frame-${plan.segments.length - 1}.png'\n`;
    await writeFile(path.join(tempRoot, 'frames.txt'), concat, { flag: 'wx' });
    const output = path.join(tempRoot, 'result.mp4');
    const encoded = await run(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        'frames.txt',
        '-fps_mode',
        'vfr',
        '-vf',
        `fps=${fps}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        String(constantRateFactor),
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-an',
        '-t',
        (plan.totalDurationMs / 1000).toFixed(3),
        output,
      ],
      { signal: controller.signal, timeoutMs: ENCODE_TIMEOUT_MS, cwd: tempRoot },
    );
    if (encoded.code !== 0)
      throw new Mp4RenderError('encode-failed', `FFmpeg 编码失败：${encoded.stderr.slice(-1600)}`);
    const probed = await run(
      ffprobe,
      [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'format=format_name,duration,size:stream=codec_name,pix_fmt,width,height,nb_read_frames,duration',
        '-of',
        'json',
        output,
      ],
      { signal: controller.signal, timeoutMs: PROCESS_TIMEOUT_MS, cwd: tempRoot },
    );
    if (probed.code !== 0)
      throw new Mp4RenderError(
        'output-invalid',
        `ffprobe 读取 MP4 失败：${probed.stderr.slice(-1000)}`,
      );
    const info = probeJson(probed.stdout);
    const format = info['format'] as Record<string, unknown> | undefined;
    const streams = info['streams'] as Array<Record<string, unknown>> | undefined;
    const video = streams?.[0];
    const durationSeconds = Number(format?.['duration'] ?? video?.['duration']);
    const frameCount = Number(video?.['nb_read_frames']);
    if (
      typeof format?.['format_name'] !== 'string' ||
      !format['format_name'].split(',').includes('mp4') ||
      video?.['codec_name'] !== 'h264' ||
      video?.['pix_fmt'] !== 'yuv420p' ||
      video?.['width'] !== width ||
      video?.['height'] !== height ||
      !Number.isFinite(durationSeconds) ||
      Math.abs(durationSeconds - plan.totalDurationMs / 1000) > Math.max(1, 2 / fps) ||
      !Number.isInteger(frameCount) ||
      frameCount <= 0
    )
      throw new Mp4RenderError(
        'output-invalid',
        'MP4 探测结果与请求的容器、编码、画幅、帧数或时长不符。',
      );
    const decoded = await run(
      ffmpeg,
      [
        '-hide_banner',
        '-v',
        'error',
        '-progress',
        'pipe:1',
        '-nostats',
        '-i',
        output,
        '-map',
        '0:v:0',
        '-f',
        'null',
        '-',
      ],
      { signal: controller.signal, timeoutMs: ENCODE_TIMEOUT_MS, cwd: tempRoot },
    );
    const decodedFrames = Number(decoded.stdout.match(/^frame=(\d+)/m)?.[1]);
    if (decoded.code !== 0 || decoded.stderr.trim() || decodedFrames !== frameCount)
      throw new Mp4RenderError(
        'output-invalid',
        `MP4 全量解码失败：${decoded.stderr.slice(-1200)}`,
      );
    const outputStat = await stat(output);
    if (!outputStat.isFile() || outputStat.size <= 0 || outputStat.size > MAX_OUTPUT_BYTES)
      throw new Mp4RenderError('output-invalid', 'MP4 输出文件超出 1 GiB 读取上限。');
    const bytes = await readFile(output);
    if (bytes.byteLength === 0) throw new Mp4RenderError('output-invalid', 'MP4 文件为空。');
    const evidence: Mp4RenderEvidence = {
      mode: 'closed-scene-projection',
      interactionPreserved: false,
      audioPresent: false,
      container: String(format['format_name']),
      videoCodec: String(video['codec_name']),
      pixelFormat: String(video['pix_fmt']),
      width,
      height,
      durationSeconds,
      frameCount,
      decodedFrames,
      ffprobeVerified: true,
      fullDecodeVerified: true,
    };
    return {
      bytes,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      playable: true,
      runtimes: inspection,
      evidence,
      reusedSegments,
      capturedSegments: plan.segments.length - reusedSegments,
    };
  } catch (error) {
    if (controller.signal.aborted && !options.signal.aborted)
      throw new Mp4RenderError('timeout', 'MP4 渲染超过资源时限并已终止。');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abortForward);
    await rm(tempRoot, { recursive: true, force: true });
  }
}
