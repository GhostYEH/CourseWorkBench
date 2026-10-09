import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  inspectMp4Runtime,
  Mp4RenderError,
  renderMp4,
  type Mp4PublicDocument,
} from '../apps/learning/lib/server/mp4-renderer';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const signal = () => new AbortController().signal;
const pixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/k2cAAAAASUVORK5CYII=',
  'base64',
);

const plan = (sceneKind: 'slide' | 'interactive' = 'slide') => ({
  planVersion: 1,
  format: 'mp4',
  generatedAt: '2026-10-08T00:00:00.000Z',
  identity: {
    projectId: 'p',
    lessonId: 'l',
    lessonVersion: 1,
    bundleId: 'b',
    title: 't',
    planDigest: null,
    documentDigest: null,
    exportedDocumentDigest: null,
  },
  encoding: {
    container: 'mp4',
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    width: 640,
    height: 360,
    fps: 24,
    constantRateFactor: 28,
    fastStart: true,
    audio: null,
  },
  canvas: { viewportSize: 1000, viewportRatio: 0.5625 },
  segments: [
    {
      index: 0,
      sceneId: 'scene_1',
      sceneKind,
      title: '标题',
      startMs: 0,
      durationMs: 4000,
      sceneDigest: 'a'.repeat(64),
    },
  ],
  totalDurationMs: 4000,
  runtimes: [],
  output: { directory: 'exports', fileName: 'lesson.mp4' },
  digest: 'b'.repeat(64),
});

describe('MP4 renderer runtime boundary', () => {
  it('reports missing executables as explicit runtime gaps', async () => {
    const inspection = await inspectMp4Runtime({
      chromiumPath: 'Z:\\does-not-exist\\chrome.exe',
      ffmpegPath: 'Z:\\does-not-exist\\ffmpeg.exe',
      ffprobePath: 'Z:\\does-not-exist\\ffprobe.exe',
    });
    expect(inspection.ready).toBe(false);
    expect(inspection.gaps.map((gap) => gap.split(':')[0])).toEqual([
      'chromium',
      'ffmpeg',
      'ffprobe',
    ]);
    expect(inspection.runtimes.every((runtime) => runtime.sha256 === null)).toBe(true);
  });

  it('rejects interactive scenes before claiming a playable projection', async () => {
    const document: Mp4PublicDocument = {
      scenes: [
        { id: 'scene_1', type: 'interactive', title: '互动练习', content: { type: 'interactive' } },
      ],
    };
    await expect(
      renderMp4(plan('interactive') as never, document, new Map(), { signal: signal() }),
    ).rejects.toMatchObject({ code: 'unsupported-scene' });
  });

  it('rejects math that needs a typesetting runtime before launching a renderer', async () => {
    const document: Mp4PublicDocument = {
      scenes: [
        {
          id: 'scene_1',
          type: 'slide',
          title: '公式',
          content: {
            type: 'slide',
            canvas: {
              elements: [{ type: 'text', content: '<p style="font-size:24px">$$x^2$$</p>' }],
            },
          },
        },
      ],
    };
    await expect(
      renderMp4(plan() as never, document, new Map(), { signal: signal() }),
    ).rejects.toMatchObject({ code: 'unsupported-scene' });
  });

  it('does not mark a render playable when required runtimes are missing', async () => {
    const document: Mp4PublicDocument = {
      scenes: [
        {
          id: 'scene_1',
          type: 'slide',
          title: '标题',
          content: { type: 'slide', canvas: { elements: [] } },
        },
      ],
    };
    await expect(
      renderMp4(plan() as never, document, new Map(), {
        signal: signal(),
        chromiumPath: 'Z:\\does-not-exist\\chrome.exe',
        ffmpegPath: 'Z:\\does-not-exist\\ffmpeg.exe',
        ffprobePath: 'Z:\\does-not-exist\\ffprobe.exe',
      }),
    ).rejects.toMatchObject({ code: 'runtime-missing' });
  });

  it('honors cancellation before reading inputs or starting child processes', async () => {
    const controller = new AbortController();
    controller.abort();
    const document: Mp4PublicDocument = { scenes: [] };
    await expect(
      renderMp4(plan() as never, document, new Map(), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(Mp4RenderError);
  });

  it.runIf(process.env['SEW_RUN_MP4_INTEGRATION'] === '1')(
    'captures a frozen slide with its text and image, encodes it, probes it, and fully decodes it',
    async () => {
      const image: Uint8Array = pixelPng;
      const publicDocument: Mp4PublicDocument = {
        scenes: [
          {
            id: 'scene_1',
            type: 'slide',
            title: '牛顿第二定律',
            content: {
              type: 'slide',
              canvas: {
                id: 'canvas_1',
                viewportSize: 1000,
                viewportRatio: 0.5625,
                theme: { backgroundColor: '#f4f6fb' },
                elements: [
                  {
                    type: 'text',
                    left: 80,
                    top: 90,
                    width: 800,
                    height: 140,
                    content: '<p style="font-size:42px;color:#1a2b3c;text-align:left">F = ma</p>',
                  },
                  {
                    type: 'image',
                    left: 720,
                    top: 300,
                    width: 80,
                    height: 80,
                    src: 'asset:symbol-1',
                  },
                ],
              },
            },
          },
        ],
      };
      const encodedPlan = plan() as ReturnType<typeof plan> & { encoding: { audio: null } };
      const pngSegments = new Map<number, Uint8Array>();
      const result = await renderMp4(
        encodedPlan as never,
        publicDocument,
        new Map([
          ['asset:symbol-1', { bytes: image, mediaType: 'image/png', sha256: hash(image) }],
        ]),
        {
          signal: signal(),
          onSegment: (index, png) => {
            pngSegments.set(index, png);
          },
        },
      );
      expect(result.playable).toBe(true);
      expect(result.evidence).toMatchObject({
        mode: 'closed-scene-projection',
        interactionPreserved: false,
        audioPresent: false,
        videoCodec: 'h264',
        pixelFormat: 'yuv420p',
        width: 640,
        height: 360,
        ffprobeVerified: true,
        fullDecodeVerified: true,
      });
      expect(result.evidence.frameCount).toBeGreaterThan(0);
      expect(result.sha256).toBe(hash(result.bytes));
      expect(pngSegments.get(0)?.subarray(0, 8)).toEqual(Buffer.from('89504e470d0a1a0a', 'hex'));
      const evidencePath = process.env['SEW_MP4_EVIDENCE_PATH'];
      if (evidencePath) await writeFile(evidencePath, result.bytes, { flag: 'w' });
    },
    180_000,
  );
});
