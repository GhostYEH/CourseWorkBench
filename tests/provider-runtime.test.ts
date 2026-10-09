import { describe, expect, it } from 'vitest';
import { MODEL_PROVIDER_IDS, modelConnectionInputSchema } from '@sew/study-contracts';
import {
  generateWithProvider,
  createGuardedProviderFetch,
  discoverBedrockFoundationModels,
  discoverProviderModels,
} from '../apps/learning/lib/server/provider-runtime';
import type { ModelConnectionInput } from '@sew/study-contracts';
import {
  PROVIDER_REGISTRY,
  getProviderDefinition,
} from '../apps/learning/lib/server/provider-registry';

const secret = 'fixture-native-provider-secret';
const run = async (
  config: ModelConnectionInput,
  response: unknown,
  inspect: (url: string, init: RequestInit) => void,
) =>
  generateWithProvider({
    config,
    messages: [{ role: 'user', content: 'Reply exactly OK.' }],
    maxTokens: 1024,
    signal: new AbortController().signal,
    fetcher: async (input, init = {}) => {
      inspect(String(input), init);
      return Response.json(response);
    },
  });

describe('model provider contracts and native protocol consumers', () => {
  it('has registry entries for every fixed upstream provider id and the legacy compatible id', () => {
    for (const id of MODEL_PROVIDER_IDS) expect(PROVIDER_REGISTRY[id]?.id).toBe(id);
    expect(PROVIDER_REGISTRY['openai-compatible']?.id).toBe('openai-compatible');
    expect(getProviderDefinition('custom-school-gateway').protocol).toBe('openai');
  });

  it('keeps custom OpenAI-compatible configs while allowing only loopback HTTP', () => {
    expect(
      modelConnectionInputSchema.safeParse({
        provider: 'openai-compatible',
        baseUrl: 'https://gateway.example/v1',
        model: 'custom-model',
        apiKey: secret,
      }).success,
    ).toBe(true);
    for (const baseUrl of ['http://example.com/v1', 'http://192.168.1.2/v1', 'http://0.0.0.0/v1']) {
      expect(
        modelConnectionInputSchema.safeParse({
          provider: 'ollama',
          baseUrl,
          model: 'llama3.3',
        }).success,
      ).toBe(false);
    }
    expect(
      modelConnectionInputSchema.safeParse({
        provider: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.3',
      }).success,
    ).toBe(true);
    expect(
      modelConnectionInputSchema.safeParse({
        provider: 'bedrock',
        region: 'us-west-2',
        model: 'anthropic.claude-model',
        apiKey: secret,
      }).success,
    ).toBe(true);
    expect(
      modelConnectionInputSchema.safeParse({
        provider: 'bedrock',
        region: 'us-west-2',
        model: 'anthropic.claude-model',
        accessKeyId: 'aws-access',
      }).success,
    ).toBe(false);
    expect(
      modelConnectionInputSchema.safeParse({
        provider: 'bedrock',
        region: 'us-west-2',
        model: 'anthropic.claude-model',
        apiKey: secret,
        accessKeyId: 'aws-access',
        secretAccessKey: 'aws-secret',
      }).success,
    ).toBe(false);
    expect(
      modelConnectionInputSchema.safeParse({
        provider: 'bedrock',
        region: 'us-west-2',
        model: 'anthropic.claude-model',
        sessionToken: 'session-token',
      }).success,
    ).toBe(false);
  });

  it('uses Anthropic Messages with x-api-key and reports provider usage', async () => {
    const config = modelConnectionInputSchema.parse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: secret,
    });
    const result = await run(
      config,
      {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 2 },
      },
      (url, init) => {
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        expect(new Headers(init.headers).get('x-api-key')).toBe(secret);
        expect(new Headers(init.headers).get('anthropic-version')).toBe('2023-06-01');
        expect(new Headers(init.headers).get('authorization')).toBeNull();
        expect(init.redirect).toBe('error');
      },
    );
    expect(result.text).toBe('OK');
    expect(result.usage.totalTokens).toBe(9);
  });

  it('uses Google generateContent with the key in a header, never the request URL', async () => {
    const config = modelConnectionInputSchema.parse({
      provider: 'google',
      model: 'gemini-2.5-flash',
      apiKey: secret,
    });
    const result = await run(
      config,
      {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP', index: 0 },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
        modelVersion: 'gemini-2.5-flash',
      },
      (url, init) => {
        expect(url).toBe(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        );
        expect(url).not.toContain(secret);
        expect(new Headers(init.headers).get('x-goog-api-key')).toBe(secret);
        expect(new Headers(init.headers).get('authorization')).toBeNull();
        expect(init.redirect).toBe('error');
      },
    );
    expect(result.text).toBe('OK');
    expect(result.usage.totalTokens).toBe(6);
  });

  it('uses Azure deployment URL, configured api-version and api-key header', async () => {
    const config = modelConnectionInputSchema.parse({
      provider: 'azure',
      baseUrl: 'https://tenant.openai.azure.com/openai',
      apiVersion: '2024-10-21',
      model: 'lesson-deployment',
      apiKey: secret,
    });
    const result = await run(
      config,
      {
        id: 'chatcmpl_fixture',
        object: 'chat.completion',
        created: 1,
        model: 'lesson-deployment',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
      (rawUrl, init) => {
        const url = new URL(rawUrl);
        expect(url.pathname).toBe('/openai/deployments/lesson-deployment/chat/completions');
        expect(url.searchParams.get('api-version')).toBe('2024-10-21');
        expect(new Headers(init.headers).get('api-key')).toBe(secret);
        expect(new Headers(init.headers).get('authorization')).toBeNull();
      },
    );
    expect(result.text).toBe('OK');
    expect(result.usage.totalTokens).toBe(6);
  });

  it('uses native Bedrock Converse over the regional HTTPS endpoint', async () => {
    const config = modelConnectionInputSchema.parse({
      provider: 'bedrock',
      region: 'us-west-2',
      model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
      apiKey: secret,
    });
    const result = await run(
      config,
      {
        output: { message: { role: 'assistant', content: [{ text: 'OK' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      },
      (rawUrl, init) => {
        const url = new URL(rawUrl);
        expect(url.origin).toBe('https://bedrock-runtime.us-west-2.amazonaws.com');
        expect(url.pathname).toContain(
          '/model/anthropic.claude-3-5-sonnet-20240620-v1%3A0/converse',
        );
        expect(init.redirect).toBe('error');
        // Bedrock API keys use AWS's bearer-token mode; the key must not be embedded in the URL.
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${secret}`);
        expect(url.href).not.toContain(secret);
      },
    );
    expect(result.text).toBe('OK');
    expect(result.usage.totalTokens).toBe(4);
  });

  it('rejects remote HTTP, redirects, oversized JSON and invalid UTF-8 before parsing', async () => {
    const signal = new AbortController().signal;
    const reject = createGuardedProviderFetch(async () => Response.json({}), signal);
    await expect(
      reject('http://provider.example/v1/chat/completions', { method: 'POST' }),
    ).rejects.toThrow('https');
    const redirect = createGuardedProviderFetch(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      return Response.redirect('https://outside.example/', 302);
    }, signal);
    await expect(redirect('https://provider.example/v1/chat/completions')).rejects.toThrow();
    const tooLarge = createGuardedProviderFetch(
      async () => new Response('x'.repeat(128 * 1024 + 1)),
      signal,
    );
    await expect(tooLarge('https://provider.example/v1/chat/completions')).rejects.toThrow(
      'provider_response_too_large',
    );
    const invalidUtf8 = createGuardedProviderFetch(
      async () => new Response(new Uint8Array([0xff, 0xfe])),
      signal,
    );
    await expect(invalidUtf8('https://provider.example/v1/chat/completions')).rejects.toThrow();
  });

  it('discovers Anthropic models through its models API with bounded JSON and no redirects', async () => {
    const config = modelConnectionInputSchema.parse({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: secret,
    });
    const models = await discoverProviderModels({
      config,
      signal: new AbortController().signal,
      fetcher: async (url, init) => {
        expect(String(url)).toBe('https://api.anthropic.com/v1/models');
        expect(new Headers(init?.headers).get('x-api-key')).toBe(secret);
        expect(init?.redirect).toBe('error');
        return Response.json({ data: [{ id: 'claude-sonnet-4-6' }, { id: 'bad model\nsecret' }] });
      },
    });
    expect(models).toEqual(['claude-sonnet-4-6']);
  });

  it('routes Bedrock control-plane discovery through the guarded fetch transport', async () => {
    const config = modelConnectionInputSchema.parse({
      provider: 'bedrock',
      region: 'us-west-2',
      model: 'us.anthropic.claude-sonnet-4-6',
      accessKeyId: 'AKIAFIXTUREACCESS',
      secretAccessKey: 'fixture-aws-secret-key',
    });
    const models = await discoverBedrockFoundationModels(
      config,
      new AbortController().signal,
      async (url, init) => {
        const parsed = new URL(String(url));
        expect(parsed.origin).toBe('https://bedrock.us-west-2.amazonaws.com');
        expect(parsed.href).not.toContain('fixture-aws-secret-key');
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
        expect(init?.redirect).toBe('error');
        return Response.json({
          modelSummaries: [
            { modelId: 'us.anthropic.claude-sonnet-4-6' },
            { modelId: 'amazon.nova-pro-v1:0' },
          ],
        });
      },
    );
    expect(models).toEqual(['us.anthropic.claude-sonnet-4-6', 'amazon.nova-pro-v1:0']);
  });
});
