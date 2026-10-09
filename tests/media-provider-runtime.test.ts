import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelConnectionRuntime } from '../apps/learning/lib/server/model-connection';
import { mediaGenerationCommandSchema, type MediaGenerationCommandDto } from '@sew/study-contracts';

const config = {
  provider: 'openai-compatible' as const,
  baseUrl: 'https://media.example/v1',
  model: 'configured-text-model',
  apiKey: 'media-secret-test-only',
};
const scope = { projectId: 'p-media', generation: 1, runId: 'run-media' };
const command = (
  kind: 'image' | 'video' | 'tts' | 'asr',
  overrides: Record<string, unknown> = {},
): MediaGenerationCommandDto =>
  mediaGenerationCommandSchema.parse({
    kind,
    scope,
    requestId: `req-${kind}`,
    provider: 'openai-compatible',
    model: `${kind}-fixture-model`,
    ...(kind === 'image'
      ? {
          prompt: '图像候选',
          workflowId: 'openai-images',
          workflowLocation: 'remote',
          width: 1024,
          height: 1024,
          steps: 20,
          guidance: 7,
          count: 1,
        }
      : {}),
    ...(kind === 'video'
      ? {
          prompt: '视频候选',
          durationSeconds: 8,
          poll: { intervalMs: 1, maxPolls: 2, deadlineMs: 1000 },
        }
      : {}),
    ...(kind === 'tts' ? { text: '测试语音', voiceId: 'alloy', playbackRate: 1.5 } : {}),
    ...(kind === 'asr'
      ? {
          engine: 'remote',
          microphoneGranted: true,
          audioAssetId: 'audio-1',
          audioSeconds: 0.5,
          locale: 'zh-CN',
        }
      : {}),
    ...overrides,
  });
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
);
const imageReply = () =>
  Response.json({
    data: [{ b64_json: png.toString('base64') }],
    usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
  });
const wav = (): Uint8Array => {
  const b = Buffer.alloc(48);
  b.write('RIFF', 0);
  b.writeUInt32LE(40, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8_000, 24);
  b.writeUInt32LE(16_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(4, 40);
  return b;
};
// One H.264 keyframe remuxed from Chromium media/test/data/bear.mp4 (BSD test fixture).
const mp4 = (): Uint8Array =>
  Buffer.from(
    'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAABjbbWRhdAAAAkIGBf//PtxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSA2NyByMTE0NSBkMmUx' +
      'ZTFjIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAwOSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9w' +
      'dGlvbnM6IGNhYmFjPTEgcmVmPTQgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9OSBwc3lfcmQ9MS4wOjAuMCBtaXhlZF9y' +
      'ZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgY2hyb21hX3FwX29mZnNldD0tMiB0' +
      'aHJlYWRzPTQgbnI9MCBkZWNpbWF0ZT0xIG1iYWZmPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0wIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3cHJlZGI9' +
      'MSBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCByYz0ycGFzcyBiaXRyYXRlPTI1MCByYXRldG9sPTEuMCBxY29tcD0wLjYwIHFwbWluPTEw' +
      'IHFwbWF4PTUxIHFwc3RlcD00IGNwbHhibHVyPTIwLjAgcWJsdXI9MC41IGlwX3JhdGlvPTEuNDAgcGJfcmF0aW89MS4zMCBhcT0xOjEuMDAAgAAAFolliIAg' +
      'Af/zfsiTf1R4lNl9GWCoT4JPbG7yQ9tqbW7wF5237QmNwfb9OK8ZLXhtOtt8R4Ncmo3WY5kCZaFxpZftGK5zSkVFfLMZJMgwF77X8Kgl/nHir0xdhacg3c+E' +
      'W8nq2ZLnhO7n1KNJFGxSNo8KA/EbY9sucv92rtnl1rrrXbUJ7lA8VU7qpePksmtfGX/pRDvM6zzoOO6b3jWJA9/dhEC8snMzMlkdqRdYaugbkUCEU8gYDVeA' +
      'EzmxETRBFMggWhLvTdvryWwutqsgTTj2drjcXkINhjaBkrBJtPGTWdETvopy5O54ZemJ50Z6wkXxWgOPWjQsNG8DjFMBK6c2g4+C+C+Sy7xCDvg+fe4Rv0px' +
      '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' +
      'ABRzdGNvAAAAAAAAAAEAAAAo',
    'base64',
  );
const configured = (
  fetcher: typeof fetch,
  options: Partial<Parameters<typeof createModelConnectionRuntime>[0]> = {},
) => {
  const runtime = createModelConnectionRuntime({ fetcher, ...options });
  runtime.configure(config, false);
  return runtime;
};
const responseBytes = (bytes: Uint8Array, type = 'application/octet-stream') =>
  new Response(Uint8Array.from(bytes), { headers: { 'content-type': type } });
afterEach(() => vi.useRealTimers());

describe('真实兼容媒体 provider 消费层', () => {
  it('images/generations uses command model, private bearer and base64, keeps credentials write-only', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(`${config.baseUrl}/images/generations`);
      expect(init?.redirect).toBe('error');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${config.apiKey}`);
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'image-fixture-model',
        prompt: '图像候选',
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json',
      });
      return imageReply();
    });
    const runtime = configured(fetcher);
    const result = await runtime.generateMedia(command('image'));
    expect(result).toMatchObject({
      dispatched: true,
      ok: true,
      failureKind: null,
      usageMeasurement: 'actual',
      usage: { images: 1, tokens: { totalTokens: 7 } },
    });
    expect(Buffer.from(result.products[0]!.bytes)).toEqual(png);
    expect(result.products[0]!.mime).toBe('image/png');
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
    expect(JSON.stringify(runtime.status())).not.toContain(config.apiKey);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('GPT image request omits unsupported response_format', async () => {
    const runtime = configured(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.output_format).toBe('png');
      expect(body.response_format).toBeUndefined();
      return imageReply();
    });
    expect((await runtime.generateMedia(command('image', { model: 'gpt-image-1' }))).ok).toBe(true);
  });

  it('valid minimal JPEG/WebP assets pass container checks while truncated variants fail', async () => {
    // Public minimal decodable fixtures from github.com/mathiasbynens/small.
    const jpeg = Buffer.from(
      '/9j/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=',
      'base64',
    );
    const webp = Buffer.from('UklGRhIAAABXRUJQVlA4TAYAAAAvQWxvAGs=', 'base64');
    for (const [bytes, mime] of [
      [jpeg, 'image/jpeg'],
      [webp, 'image/webp'],
    ] as const) {
      const runtime = configured(async () =>
        Response.json({ data: [{ b64_json: bytes.toString('base64') }] }),
      );
      expect(await runtime.generateMedia(command('image'))).toMatchObject({
        ok: true,
        products: [{ mime }],
      });
      const bad = configured(async () =>
        Response.json({
          data: [{ b64_json: bytes.subarray(0, bytes.length - 1).toString('base64') }],
        }),
      );
      expect(await bad.generateMedia(command('image'))).toMatchObject({ ok: false, products: [] });
    }
  });

  it('PNG requires complete chunks, valid CRC, complete IEND and decodable scanline data', async () => {
    const corrupt = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    );
    const repairedCrc = Buffer.from(corrupt);
    repairedCrc.writeUInt32BE(0x9973e8e5, 54); // CRC fixed; compressed stream is still invalid.
    const invalidChunk = Buffer.from(png);
    invalidChunk.writeUInt32BE(0xffffffff, 33);
    for (const bytes of [
      png.subarray(0, 24),
      png.subarray(0, 33),
      png.subarray(0, png.length - 12),
      corrupt,
      repairedCrc,
      invalidChunk,
    ]) {
      const result = await configured(async () =>
        Response.json({ data: [{ b64_json: bytes.toString('base64') }] }),
      ).generateMedia(command('image'));
      expect(result).toMatchObject({ ok: false, products: [] });
    }
  });

  it('TTS consumes actual binary WAV, playback speed stays in the player and characters are estimated', async () => {
    const runtime = configured(async (url, init) => {
      expect(url).toBe(`${config.baseUrl}/audio/speech`);
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'tts-fixture-model',
        input: '测试语音',
        voice: 'alloy',
        response_format: 'wav',
      });
      return responseBytes(wav(), 'text/html');
    });
    const result = await runtime.generateMedia(command('tts'));
    expect(result).toMatchObject({
      ok: true,
      usageMeasurement: 'estimated',
      usage: { characters: 4, audioSeconds: null },
    });
    expect(result.products[0]).toMatchObject({ mime: 'audio/wav', durationSeconds: null });
    expect(Buffer.from(result.products[0]!.bytes)).toEqual(Buffer.from(wav()));
  });

  it('ASR sends asset bytes as multipart, never a URL or local path, returns UTF8 text and duration usage', async () => {
    const runtime = configured(async (url, init) => {
      expect(url).toBe(`${config.baseUrl}/audio/transcriptions`);
      expect(new Headers(init?.headers).has('content-type')).toBe(false);
      const body = init?.body as FormData;
      expect(body.get('model')).toBe('asr-fixture-model');
      expect(body.get('response_format')).toBe('json');
      expect(body.get('language')).toBe('zh');
      const file = body.get('file') as File;
      expect(file.name).toBe('recording.wav');
      expect(file.type).toBe('audio/wav');
      expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from(wav()));
      return Response.json({ text: '实际转写候选', usage: { type: 'duration', seconds: 0.5 } });
    });
    const result = await runtime.generateMedia(command('asr'), {
      audio: { bytes: wav(), mime: 'audio/wav' },
    });
    expect(result).toMatchObject({
      ok: true,
      usageMeasurement: 'actual',
      usage: { asrSeconds: 0.5 },
    });
    expect(result.products[0]!.mime).toBe('text/plain');
    expect(new TextDecoder().decode(result.products[0]!.bytes)).toBe('实际转写候选');
  });

  it('ASR without provider duration is explicitly estimated from the command', async () => {
    const runtime = configured(async () => Response.json({ text: '候选' }));
    expect(
      await runtime.generateMedia(command('asr'), { audio: { bytes: wav(), mime: 'audio/wav' } }),
    ).toMatchObject({ ok: true, usageMeasurement: 'estimated', usage: { asrSeconds: 0.5 } });
  });

  it('accepts MP3 frame bytes and rejects header-only WAV/ID3 without audio data', async () => {
    const mp3 = Buffer.alloc(417);
    mp3.set([0xff, 0xfb, 0x90, 0x64]);
    const result = await configured(async () => responseBytes(mp3)).generateMedia(command('tts'));
    expect(result).toMatchObject({ ok: true, products: [{ mime: 'audio/mpeg' }] });
    const emptyWav = Buffer.from(wav());
    emptyWav.writeUInt32LE(0, 40);
    const emptyMp3 = Buffer.alloc(10);
    emptyMp3.write('ID3');
    emptyMp3[3] = 4;
    for (const bytes of [emptyWav, emptyMp3]) {
      expect(
        await configured(async () => responseBytes(bytes)).generateMedia(command('tts')),
      ).toMatchObject({ ok: false, products: [] });
    }
  });

  it('video dispatches multipart, polls the stable job ID then downloads only configured endpoint content', async () => {
    let calls = 0;
    const runtime = configured(async (url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${config.apiKey}`);
      expect(init?.redirect).toBe('error');
      calls++;
      if (calls === 1) {
        expect(url).toBe(`${config.baseUrl}/videos`);
        expect(init?.method).toBe('POST');
        const body = init?.body as FormData;
        expect(body.get('seconds')).toBe('8');
        expect(body.get('size')).toBe('1280x720');
        expect(body.get('model')).toBe('video-fixture-model');
        return Response.json({ id: 'video_fixture', status: 'queued', seconds: '8' });
      }
      if (calls === 2) {
        expect(url).toBe(`${config.baseUrl}/videos/video_fixture`);
        return Response.json({ id: 'video_fixture', status: 'completed', seconds: '8' });
      }
      expect(url).toBe(`${config.baseUrl}/videos/video_fixture/content`);
      return responseBytes(mp4());
    });
    expect(await runtime.generateMedia(command('video'))).toMatchObject({
      ok: true,
      providerJobId: 'video_fixture',
      usageMeasurement: 'actual',
      usage: { videoSeconds: 8 },
      products: [{ mime: 'video/mp4', durationSeconds: 8 }],
    });
    expect(calls).toBe(3);
  });

  it('video never treats a job ID without downloaded valid content as success and stops at poll limit', async () => {
    let calls = 0;
    const runtime = configured(async () => {
      calls++;
      return Response.json({ id: 'video_fixture', status: 'queued' });
    });
    expect(await runtime.generateMedia(command('video'))).toMatchObject({
      dispatched: true,
      ok: false,
      failureKind: 'poll_limit_exceeded',
      products: [],
      providerJobId: 'video_fixture',
      usage: null,
      usageMeasurement: 'unknown',
    });
    expect(calls).toBe(3);
    const empty = configured(async (url) =>
      String(url).endsWith('/content')
        ? new Response(null)
        : Response.json({ id: 'video_fixture', status: 'completed' }),
    );
    expect((await empty.generateMedia(command('video'))).ok).toBe(false);
  });

  it('MP4 requires complete box framing, a video track and nonempty media data', async () => {
    const real = Buffer.from(mp4());
    const fakeSize = Buffer.from(real);
    fakeSize.writeUInt32BE(real.length + 1, 32);
    const missingMoov = real.subarray(0, 32 + real.readUInt32BE(32));
    const missingMdat = Buffer.concat([
      real.subarray(0, 32),
      real.subarray(32 + real.readUInt32BE(32)),
    ]);
    for (const bytes of [
      real.subarray(0, 24),
      real.subarray(0, 32),
      real.subarray(0, real.length - 1),
      fakeSize,
      missingMoov,
      missingMdat,
    ]) {
      const runtime = configured(async (url) =>
        String(url).endsWith('/content')
          ? responseBytes(bytes)
          : Response.json({ id: 'video_fixture', status: 'completed' }),
      );
      expect(await runtime.generateMedia(command('video'))).toMatchObject({
        ok: false,
        products: [],
        providerJobId: 'video_fixture',
      });
    }
  });

  it('rejects untrusted video IDs and mismatched poll IDs before fetching content', async () => {
    for (const id of ['../secret', 'https://private.example/task', config.apiKey]) {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id, status: 'completed' }));
      expect(await configured(fetcher).generateMedia(command('video'))).toMatchObject({
        ok: false,
        products: [],
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    let calls = 0;
    const runtime = configured(async () =>
      Response.json({
        id: ++calls === 1 ? 'video_expected' : 'video_other',
        status: calls === 1 ? 'queued' : 'completed',
      }),
    );
    expect(await runtime.generateMedia(command('video'))).toMatchObject({
      ok: false,
      products: [],
      providerJobId: 'video_expected',
    });
    expect(calls).toBe(2);
  });

  it('unsupported/local/retired providers and invalid ASR audio fail before any dispatch', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => imageReply());
    const runtime = configured(fetcher);
    for (const c of [
      command('image', { provider: 'unimplemented' }),
      command('image', { workflowLocation: 'local' }),
      command('image', { referenceAssetId: 'reference-1' }),
      command('image', { negativePrompt: '不支持' }),
      command('image', { steps: 50 }),
      command('image', { guidance: 12 }),
      command('asr', { engine: 'local_whisper' }),
      command('asr', { microphoneGranted: false }),
    ])
      expect((await runtime.generateMedia(c)).dispatched).toBe(false);
    expect((await runtime.generateMedia(command('asr'))).dispatched).toBe(false);
    expect(
      (await runtime.generateMedia(command('asr'), { audio: { bytes: png, mime: 'audio/wav' } }))
        .dispatched,
    ).toBe(false);
    runtime.configure({ ...config, baseUrl: 'https://api.openai.com/v1' }, false);
    expect(await runtime.generateMedia(command('video'))).toMatchObject({
      ok: false,
      dispatched: false,
      failureKind: 'provider_error',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('image URL-only, corrupt base64, empty and wrong format results fail without fetching a remote URL', async () => {
    for (const body of [
      { data: [{ url: 'https://private.example/secret' }] },
      { data: [] },
      { data: [{ b64_json: '%%%%' }] },
      { data: [{ b64_json: Buffer.from('not an image').toString('base64') }] },
      { data: [{ b64_json: png.toString('base64'), url: 'https://private.example/secret' }] },
      { data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }] },
    ]) {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json(body));
      const outcome = await configured(fetcher).generateMedia(command('image'));
      expect(outcome).toMatchObject({ ok: false, products: [], usageMeasurement: 'unknown' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('failure bodies and transport exceptions cannot leak credentials or provider details', async () => {
    const fixtures: Array<typeof fetch> = [
      async () => new Response(config.apiKey, { status: 401 }),
      async () => {
        throw new Error(`${config.apiKey}: debug failure`);
      },
      async () => new Response(config.apiKey),
    ];
    for (const fetcher of fixtures) {
      const runtime = configured(fetcher);
      const outcome = await runtime.generateMedia(command('image'));
      expect(outcome.ok).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain(config.apiKey);
      expect(JSON.stringify(runtime.status())).not.toContain(config.apiKey);
    }
  });

  it('network rejection is explicit and preserves unknown dispatched usage', async () => {
    const runtime = configured(async () => {
      throw new TypeError(config.apiKey);
    });
    expect(await runtime.generateMedia(command('image'))).toMatchObject({
      ok: false,
      dispatched: true,
      failureKind: 'no_connection',
      usage: null,
      usageMeasurement: 'unknown',
    });
  });

  it('strict JSON decoding rejects malformed UTF8 and ASR cannot return blank or echoed credentials', async () => {
    for (const response of [
      responseBytes(Uint8Array.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125])),
      Response.json({ text: '  ' }),
      Response.json({ text: config.apiKey }),
    ]) {
      const result = await configured(async () => response).generateMedia(command('asr'), {
        audio: { bytes: wav(), mime: 'audio/wav' },
      });
      expect(result).toMatchObject({ ok: false, products: [] });
      expect(JSON.stringify(result)).not.toContain(config.apiKey);
    }
  });

  it('checks actual streamed bytes without trusting Content-Length and cancels oversized streams', async () => {
    let cancelled = false;
    let parts = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          parts++;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-length': '48', 'content-type': 'audio/wav' } },
    );
    const result = await configured(async () => response).generateMedia(command('tts'));
    expect(result).toMatchObject({ ok: false, products: [], usageMeasurement: 'unknown' });
    expect(cancelled).toBe(true);
    expect(parts).toBeLessThanOrEqual(18);
  });

  it('bounds image JSON wire bytes and each decoded image resource', async () => {
    const huge = Buffer.alloc(16 * 1024 * 1024 + 1);
    png.copy(huge);
    const runtime = configured(async () =>
      Response.json({ data: [{ b64_json: huge.toString('base64') }] }),
    );
    expect((await runtime.generateMedia(command('image'))).ok).toBe(false);
    let cancelled = false;
    const wire = configured(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    expect((await wire.generateMedia(command('image'))).ok).toBe(false);
    expect(cancelled).toBe(true);
  });

  it('shares active-call exclusion and generation rate limit with text even across reconfiguration', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/chat/completions')
        ? Response.json({
            choices: [{ message: { content: 'fixture text' } }],
            usage: { total_tokens: 2 },
          })
        : new Promise((resolve) => {
            release = resolve;
          }),
    );
    const runtime = configured(fetcher, { generationMaxCallsPerMinute: 2, now: () => 10_000 });
    const pending = runtime.generateMedia(command('image'));
    expect((await runtime.generate([{ role: 'user', content: 'fixture' }])).dispatched).toBe(false);
    expect((await runtime.test()).ok).toBe(false);
    release(imageReply());
    expect((await pending).ok).toBe(true);
    expect((await runtime.generate([{ role: 'user', content: 'fixture' }])).ok).toBe(true);
    runtime.configure({ ...config, model: 'new-configured-model' }, false);
    expect((await runtime.generateMedia(command('image'))).dispatched).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('same endpoint credential changes abort in-flight media, drop late success and advance revision', async () => {
    let release!: (response: Response) => void;
    const runtime = configured(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const epoch = runtime.revision();
    const pending = runtime.generateMedia(command('image'));
    runtime.configure({ ...config, apiKey: 'changed-secret-fixture' }, false);
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      failureKind: 'cancelled',
      products: [],
      dispatched: true,
    });
    expect(runtime.revision()).toBeGreaterThan(epoch);
    release(imageReply());
    expect(JSON.stringify(result)).not.toContain(config.apiKey);
  });

  it('external cancel and shutdown are bounded even when the transport never resolves', async () => {
    const runtime = configured(async () => new Promise(() => undefined));
    const external = new AbortController();
    const pending = runtime.generateMedia(command('image'), { signal: external.signal });
    external.abort();
    expect(await pending).toMatchObject({ ok: false, failureKind: 'cancelled', products: [] });
    const next = runtime.generateMedia(command('image'));
    runtime.cancel();
    expect(await next).toMatchObject({ ok: false, failureKind: 'cancelled' });
    expect((await runtime.generateMedia(command('image'))).dispatched).toBe(false);
  });

  it('deadline and configured video deadline abort hanging requests rather than hanging the task', async () => {
    vi.useFakeTimers();
    const runtime = configured(async () => new Promise(() => undefined), {
      generationDeadlineMs: 10,
    });
    const pending = runtime.generateMedia(command('image'));
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toMatchObject({
      failureKind: 'deadline_exceeded',
      ok: false,
      dispatched: true,
      usageMeasurement: 'unknown',
    });
    const video = configured(async () => Response.json({ id: 'video_fixture', status: 'queued' }), {
      generationDeadlineMs: 100,
    });
    const videoPending = video.generateMedia(
      command('video', { poll: { intervalMs: 20, maxPolls: 20, deadlineMs: 5 } }),
    );
    await vi.advanceTimersByTimeAsync(6);
    expect(await videoPending).toMatchObject({
      failureKind: 'deadline_exceeded',
      providerJobId: 'video_fixture',
      ok: false,
    });
  });

  it('deadline also cancels stalled response-body reads after headers have arrived', async () => {
    vi.useFakeTimers();
    for (const kind of ['image', 'tts'] as const) {
      let cancelled = false;
      const runtime = configured(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
              },
            }),
          ),
        { generationDeadlineMs: 5 },
      );
      const pending = runtime.generateMedia(command(kind));
      await vi.advanceTimersByTimeAsync(6);
      expect(await pending).toMatchObject({
        ok: false,
        failureKind: 'deadline_exceeded',
        products: [],
      });
      expect(cancelled).toBe(true);
    }
  });
});
