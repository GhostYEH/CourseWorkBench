import { describe, expect, it, vi } from 'vitest';
import { mediaGenerationCommandSchema } from '@sew/study-contracts';
import { createModelConnectionRuntime } from '../apps/learning/lib/server/model-connection';

const wave = (): Uint8Array => {
  const bytes = Buffer.alloc(44 + 3200);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
};

const localCommand = () =>
  mediaGenerationCommandSchema.parse({
    scope: { projectId: 'p-local', generation: 1, runId: 'run-local' },
    requestId: 'local-connection-request',
    provider: 'whisper',
    kind: 'asr',
    engine: 'local_whisper',
    microphoneGranted: true,
    audioAssetId: 'recording-1',
    audioSeconds: 0.2,
    locale: 'zh-CN',
  });
const localImageCommand = () =>
  mediaGenerationCommandSchema.parse({
    scope: { projectId: 'p-local', generation: 1, runId: 'run-local' },
    requestId: 'local-image-request',
    provider: 'comfyui',
    kind: 'image',
    prompt: 'a verified fixture only',
    workflowId: 'basic-txt2img',
    workflowLocation: 'local',
    width: 64,
    height: 64,
    steps: 5,
    guidance: 1,
    count: 1,
  });
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
);

describe('shared model connection local media integration', () => {
  it('uses shared media dispatch while preserving remote text status and redacting local credentials', async () => {
    const urls: string[] = [];
    const runtime = createModelConnectionRuntime({
      localMediaDependencies: {
        fetcher: vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
          urls.push(String(input));
          return Response.json({ text: '本地转写候选', duration: 0.2 });
        }),
      },
    });
    const secret = 'local-test-secret';
    runtime.configureLocalMedia({
      whisper: {
        baseUrl: 'https://whisper.example/v1',
        model: 'whisper-large-v3',
        bearerToken: secret,
      },
    });
    expect(runtime.status().configured).toBe(false);
    expect(runtime.mediaConfigured(localCommand())).toBe(true);
    expect(JSON.stringify(runtime.localMediaStatus())).not.toContain(secret);
    const outcome = await runtime.generateMedia(localCommand(), {
      audio: { bytes: wave(), mime: 'audio/wav' },
    });
    expect(outcome).toMatchObject({ dispatched: true, ok: true, usageMeasurement: 'actual' });
    expect(new TextDecoder().decode(outcome.products[0]?.bytes)).toBe('本地转写候选');
    expect(urls).toEqual(['https://whisper.example/v1/audio/transcriptions']);
  });

  it('cancels an active local request and advances the shared configuration revision', async () => {
    let receivedSignal: AbortSignal | undefined;
    const runtime = createModelConnectionRuntime({
      localMediaDependencies: {
        fetcher: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          receivedSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            receivedSignal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
        }),
      },
    });
    runtime.configureLocalMedia({
      whisper: { baseUrl: 'http://127.0.0.1:9000/v1', model: 'whisper-1' },
    });
    const before = runtime.revision();
    const pending = runtime.generateMedia(localCommand(), {
      audio: { bytes: wave(), mime: 'audio/wav' },
    });
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    runtime.configureLocalMedia({
      whisper: { baseUrl: 'http://127.0.0.1:9001/v1', model: 'whisper-1' },
    });
    expect(runtime.revision()).toBe(before + 1);
    expect(receivedSignal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ dispatched: true, ok: false, failureKind: 'cancelled' });
  });

  it('does not claim local engines are configured when only a remote text model exists', () => {
    const runtime = createModelConnectionRuntime();
    runtime.configure(
      {
        provider: 'openai-compatible',
        baseUrl: 'https://models.example/v1',
        model: 'text-model',
        apiKey: 'fixture-secret',
      },
      false,
    );
    expect(runtime.status().configured).toBe(true);
    expect(runtime.mediaConfigured(localCommand())).toBe(false);
    expect(runtime.localMediaStatus()).toMatchObject({ configured: false, storage: 'memory_only' });
  });

  it('routes local ComfyUI requests through the fixed safe text-to-image template', async () => {
    const calls: string[] = [];
    const runtime = createModelConnectionRuntime({
      localMediaDependencies: {
        fetcher: vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = String(input);
          calls.push(url);
          if (url.endsWith('/prompt')) {
            const body = JSON.parse(String(init?.body)) as {
              prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
            };
            expect(body.prompt['1']).toMatchObject({
              class_type: 'CheckpointLoaderSimple',
              inputs: { ckpt_name: 'installed-checkpoint.safetensors' },
            });
            expect(
              Object.values(body.prompt).every((node) =>
                [
                  'CheckpointLoaderSimple',
                  'CLIPTextEncode',
                  'EmptyLatentImage',
                  'KSampler',
                  'VAEDecode',
                  'SaveImage',
                ].includes(node.class_type),
              ),
            ).toBe(true);
            return Response.json({ prompt_id: 'fixture-job' });
          }
          if (url.endsWith('/history/fixture-job'))
            return Response.json({
              'fixture-job': {
                outputs: {
                  '7': { images: [{ filename: 'safe.png', subfolder: '', type: 'output' }] },
                },
              },
            });
          if (url.includes('/view?')) return new Response(png);
          throw new Error('unexpected fixture request');
        }),
      },
    });
    runtime.configureLocalMedia({
      comfyUi: { baseUrl: 'http://127.0.0.1:8188', checkpoint: 'installed-checkpoint.safetensors' },
    });
    expect(runtime.status().configured).toBe(false);
    expect(runtime.mediaConfigured(localImageCommand())).toBe(true);
    const outcome = await runtime.generateMedia(localImageCommand());
    expect(outcome).toMatchObject({ dispatched: true, ok: true, usage: { images: 1 } });
    expect(outcome.products[0]?.mime).toBe('image/png');
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      '/prompt',
      '/history/fixture-job',
      '/view',
    ]);
  });
});
