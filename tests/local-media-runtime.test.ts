import { describe, expect, it, vi } from 'vitest';
import { mediaGenerationCommandSchema, type MediaGenerationCommandDto } from '@sew/study-contracts';
import {
  createLocalMediaRuntime,
  validateLocalEngineEndpoint,
  type ComfyWorkflowBinding,
} from '../apps/learning/lib/server/local-media-runtime';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
);
const scope = { projectId: 'local-p', generation: 1, runId: 'local-run' };
const command = (
  kind: 'image' | 'asr',
  overrides: Record<string, unknown> = {},
): MediaGenerationCommandDto =>
  mediaGenerationCommandSchema.parse({
    scope,
    requestId: `local-${kind}`,
    provider: 'openai-compatible',
    kind,
    ...(kind === 'image'
      ? {
          prompt: 'a small test image',
          workflowId: 'trusted-basic',
          workflowLocation: 'local',
          width: 64,
          height: 64,
          steps: 5,
          guidance: 1,
          count: 1,
        }
      : {
          engine: 'local_whisper',
          microphoneGranted: true,
          audioAssetId: 'recording-1',
          audioSeconds: 0.2,
          locale: 'zh-CN',
        }),
    ...overrides,
  });

const wav = (sampleRate = 8000): Uint8Array => {
  const bytes = Buffer.alloc(44 + sampleRate * 0.2 * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
};

const graph = (): ComfyWorkflowBinding => ({
  workflow: {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder' } },
    '2': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
    '3': { class_type: 'KSampler', inputs: { steps: 20, cfg: 7 } },
  },
  promptNodeId: '1',
  widthNodeId: '2',
  heightNodeId: '2',
  stepsNodeId: '3',
  guidanceNodeId: '3',
});

describe('local media runtime', () => {
  it('limits engine destinations to loopback unless remote HTTPS auth is explicit', () => {
    expect(validateLocalEngineEndpoint({ baseUrl: 'http://127.0.0.1:8188' }).hostname).toBe(
      '127.0.0.1',
    );
    expect(validateLocalEngineEndpoint({ baseUrl: 'http://[::1]:9000/api' }).protocol).toBe(
      'http:',
    );
    expect(() => validateLocalEngineEndpoint({ baseUrl: 'http://192.168.1.4:8188' })).toThrow();
    expect(() => validateLocalEngineEndpoint({ baseUrl: 'https://engine.example' })).toThrow();
    expect(
      validateLocalEngineEndpoint({
        baseUrl: 'https://engine.example/api',
        bearerToken: 'fixture-secret',
      }).hostname,
    ).toBe('engine.example');
    expect(() =>
      validateLocalEngineEndpoint({
        baseUrl: 'https://engine.example/api',
        bearerToken: 'fixture-secret',
      }),
    ).not.toThrow();
    expect(() =>
      validateLocalEngineEndpoint({ baseUrl: 'http://localhost:8188', bearerToken: 'bad\nheader' }),
    ).toThrow();
  });

  it('submits a configured ComfyUI graph, polls its job and verifies returned image bytes', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/prompt')) {
          const payload = JSON.parse(String(init?.body)) as {
            prompt: Record<string, { inputs: Record<string, unknown> }>;
          };
          expect(payload.prompt['1']?.inputs.text).toBe('a small test image');
          expect(payload.prompt['2']?.inputs).toMatchObject({ width: 64, height: 64 });
          expect(payload.prompt['3']?.inputs).toMatchObject({ steps: 5, cfg: 1 });
          return Response.json({ prompt_id: 'job_1' });
        }
        if (url.endsWith('/history/job_1'))
          return Response.json({
            job_1: {
              outputs: {
                '9': { images: [{ filename: 'candidate.png', subfolder: '', type: 'output' }] },
              },
            },
          });
        if (url.includes('/view?'))
          return new Response(png, { headers: { 'content-type': 'application/octet-stream' } });
        throw new Error(`Unexpected local request: ${url}`);
      },
    );
    const runtime = createLocalMediaRuntime(
      {
        comfyUi: {
          baseUrl: 'http://127.0.0.1:8188',
          pollIntervalMs: 100,
          workflows: { 'trusted-basic': graph() },
        },
      },
      { fetcher, now: () => 10 },
    );
    const outcome = await runtime.generateMedia(command('image'));
    expect(outcome).toMatchObject({
      dispatched: true,
      ok: true,
      failureKind: null,
      usageMeasurement: 'actual',
      usage: { images: 1 },
    });
    expect(outcome.products[0]).toMatchObject({ mime: 'image/png', durationSeconds: null });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/prompt',
      '/history/job_1',
      '/view',
    ]);
  });

  it('rejects workflow output paths and never asks ComfyUI to read a user supplied path', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/prompt')) return Response.json({ prompt_id: 'job_2' });
      if (url.endsWith('/history/job_2'))
        return Response.json({
          job_2: {
            outputs: {
              '9': { images: [{ filename: '../secret.png', subfolder: '', type: 'output' }] },
            },
          },
        });
      throw new Error(`Unexpected request: ${url}`);
    });
    const runtime = createLocalMediaRuntime(
      {
        comfyUi: {
          baseUrl: 'http://localhost:8188',
          pollIntervalMs: 100,
          workflows: { 'trusted-basic': graph() },
        },
      },
      { fetcher },
    );
    const result = await runtime.generateMedia(command('image'));
    expect(result).toMatchObject({
      dispatched: true,
      ok: false,
      failureKind: 'provider_error',
      products: [],
      usage: null,
      usageMeasurement: 'unknown',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects custom shell or arbitrary file nodes in a configured workflow before dispatch', async () => {
    const fetcher = vi.fn();
    const unsafe = graph();
    unsafe.workflow['8'] = { class_type: 'PythonShell', inputs: { command: 'echo unsafe' } };
    const runtime = createLocalMediaRuntime(
      { comfyUi: { baseUrl: 'http://localhost:8188', workflows: { 'trusted-basic': unsafe } } },
      { fetcher },
    );
    const result = await runtime.generateMedia(command('image'));
    expect(result).toMatchObject({ dispatched: false, ok: false, failureKind: 'provider_error' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('calls the configured local Whisper protocol only after microphone authorization and checks audio duration', async () => {
    let posted: RequestInit | undefined;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        posted = init;
        return Response.json({ text: '  转写候选  ', duration: 0.2 });
      },
    );
    const runtime = createLocalMediaRuntime(
      { whisper: { baseUrl: 'http://localhost:9000/v1', model: 'whisper-large-v3' } },
      { fetcher },
    );
    const result = await runtime.generateMedia(command('asr'), {
      audio: { bytes: wav(), mime: 'audio/wav' },
    });
    expect(new TextDecoder().decode(result.products[0]?.bytes)).toContain('转写候选');
    expect(result).toMatchObject({
      dispatched: true,
      ok: true,
      usageMeasurement: 'actual',
      usage: { asrSeconds: 0.2 },
    });
    expect((posted?.body as FormData).get('file')).toMatchObject({ name: 'recording.wav' });
    expect((posted?.body as FormData).get('model')).toBe('whisper-large-v3');
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://localhost:9000/v1/audio/transcriptions');

    const denied = await runtime.generateMedia(command('asr', { microphoneGranted: false }), {
      audio: { bytes: wav(), mime: 'audio/wav' },
    });
    expect(denied).toMatchObject({
      dispatched: false,
      ok: false,
      failureKind: 'permission_denied',
      usageMeasurement: 'actual',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('speaks the FunASR runtime WebSocket protocol and fails closed when no engine is installed', async () => {
    const sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
    let socketUrl = '';
    const webSocketFactory = vi.fn((url: string, protocols?: string | string[]): WebSocket => {
      socketUrl = url;
      expect(protocols).toEqual(['binary']);
      const target = new EventTarget();
      const socket = {
        readyState: WebSocket.OPEN,
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
        close: vi.fn(),
        send(data: string | ArrayBuffer | ArrayBufferView) {
          sent.push(data);
          if (typeof data === 'string' && JSON.parse(data).is_end === true) {
            queueMicrotask(() => {
              target.dispatchEvent(
                new MessageEvent('message', {
                  data: JSON.stringify({ text: '候选转写', is_final: true }),
                }),
              );
              target.dispatchEvent(
                new MessageEvent('message', {
                  data: JSON.stringify({ is_end: true, is_final: true }),
                }),
              );
            });
          }
        },
      } as unknown as WebSocket;
      queueMicrotask(() => target.dispatchEvent(new Event('open')));
      return socket;
    });
    const runtime = createLocalMediaRuntime(
      { funAsr: { baseUrl: 'http://127.0.0.1:10095' } },
      { webSocketFactory },
    );
    const result = await runtime.generateMedia(command('asr', { engine: 'local_funasr' }), {
      audio: { bytes: wav(16_000), mime: 'audio/wav' },
    });
    expect(result).toMatchObject({
      dispatched: true,
      ok: true,
      usageMeasurement: 'actual',
      usage: { asrSeconds: 0.2 },
    });
    expect(socketUrl).toBe('ws://127.0.0.1:10095/');
    expect(JSON.parse(String(sent[0]))).toMatchObject({
      mode: 'offline',
      audio_fs: 16_000,
      wav_format: 'pcm',
      is_speaking: true,
    });
    expect(sent[1]).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(String(sent.at(-1)))).toMatchObject({ is_speaking: false, is_end: true });

    const unavailable = await createLocalMediaRuntime().generateMedia(command('asr'), {
      audio: { bytes: wav(), mime: 'audio/wav' },
    });
    expect(unavailable).toMatchObject({
      dispatched: false,
      ok: false,
      failureKind: 'local_engine_unavailable',
      usageMeasurement: 'actual',
    });
  });
});
