import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type {
  ModelConnectionInput,
  ModelConnectionStatus,
  NativeBridge,
} from '@sew/study-contracts';
import { createCommandGate, executeCommand } from '../apps/learning/lib/command-gate';
import { runModelConnectionCommand } from '../apps/learning/lib/model-connection-command';

const require = createRequire(import.meta.url);
const { validateModelConfig } = require('../apps/desktop/src/model-config.cjs') as {
  validateModelConfig: (value: ModelConnectionInput) => ModelConnectionInput;
};

const input: ModelConnectionInput = {
  provider: 'openai-compatible',
  baseUrl: 'https://fixture.invalid/v1',
  model: 'fixture-model',
  apiKey: 'fixture-only-not-a-real-secret',
};
const status: ModelConnectionStatus = {
  configured: true,
  persisted: true,
  provider: 'openai-compatible',
  baseUrl: 'https://fixture.invalid/v1',
  model: 'fixture-model',
  lastTest: null,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const modelBridge = (
  overrides: Partial<Pick<NativeBridge, 'configureModel' | 'testModel'>> = {},
) => ({
  configureModel: vi.fn(async () => undefined),
  testModel: vi.fn(async () => ({ ok: true, message: 'fixture diagnostic passed' })),
  ...overrides,
});

describe('model connection command receipts', () => {
  it('keeps a successful test receipt when the follow-up status read fails, without repeating native test', async () => {
    const bridge = modelBridge();
    const refresh = vi.fn(async () => {
      throw new Error('fixture status read failed');
    });

    const receipt = await runModelConnectionCommand(
      { action: 'test', bridge },
      { refresh, isCurrent: () => true },
    );

    expect(receipt).toEqual({
      action: 'test',
      diagnostic: { ok: true, message: 'fixture diagnostic passed' },
      statusRefreshed: false,
    });
    expect(bridge.testModel).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('retains a valid failed diagnostic when the status read also fails', async () => {
    const bridge = modelBridge({
      testModel: vi.fn(async () => ({ ok: false, message: 'fixture diagnostic failed' })),
    });
    const refresh = vi.fn(async () => {
      throw new Error('fixture status read failed');
    });

    const receipt = await runModelConnectionCommand(
      { action: 'test', bridge },
      { refresh, isCurrent: () => true },
    );

    expect(receipt).toEqual({
      action: 'test',
      diagnostic: { ok: false, message: 'fixture diagnostic failed' },
      statusRefreshed: false,
    });
    expect(bridge.testModel).toHaveBeenCalledTimes(1);
  });

  it('keeps native/schema failures on the operation error path without reading status', async () => {
    const bridge = modelBridge({
      testModel: vi.fn(async () => {
        throw new Error('fixture native test failure');
      }),
    });
    const refresh = vi.fn(async () => status);

    await expect(
      runModelConnectionCommand({ action: 'test', bridge }, { refresh, isCurrent: () => true }),
    ).rejects.toThrow('fixture native test failure');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('rejects an invalid diagnostic schema without treating it as a status-read failure', async () => {
    const bridge = modelBridge({
      testModel: vi.fn(
        async () =>
          ({
            ok: 'invalid',
            message: 'fixture malformed diagnostic',
          }) as unknown as Awaited<ReturnType<NativeBridge['testModel']>>,
      ),
    });
    const refresh = vi.fn(async () => status);

    await expect(
      runModelConnectionCommand({ action: 'test', bridge }, { refresh, isCurrent: () => true }),
    ).rejects.toThrow();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('returns an unconfirmed configure receipt after a status read failure', async () => {
    const bridge = modelBridge();
    const refresh = vi.fn(async () => {
      throw new Error('fixture status read failed');
    });

    const receipt = await runModelConnectionCommand(
      { action: 'configure', bridge, input },
      { refresh, isCurrent: () => true },
    );

    expect(receipt).toEqual({ action: 'configure', status: null });
    expect(bridge.configureModel).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not confirm persistence when refresh returns the previously configured model', async () => {
    const bridge = modelBridge();
    const previousStatus: ModelConnectionStatus = {
      ...status,
      baseUrl: 'https://previous-fixture.invalid/v1',
      model: 'previous-fixture-model',
    };

    const receipt = await runModelConnectionCommand(
      { action: 'configure', bridge, input },
      { refresh: async () => previousStatus, isCurrent: () => true },
    );

    expect(receipt).toEqual({ action: 'configure', status: null });
    expect(bridge.configureModel).toHaveBeenCalledTimes(1);
  });

  it('confirms a valid noncanonical URL using the same normalization as the native runtime', async () => {
    const noncanonicalInput: ModelConnectionInput = {
      ...input,
      baseUrl: 'https://FIXTURE.invalid:443/v1/',
    };
    const runtimeStatus: ModelConnectionStatus = {
      ...status,
      baseUrl: validateModelConfig(noncanonicalInput).baseUrl,
    };
    const bridge = modelBridge();

    const receipt = await runModelConnectionCommand(
      { action: 'configure', bridge, input: noncanonicalInput },
      { refresh: async () => runtimeStatus, isCurrent: () => true },
    );

    expect(receipt).toEqual({ action: 'configure', status: runtimeStatus });
  });

  it('also confirms a server-only status read that preserves the original valid URL spelling', async () => {
    const noncanonicalInput: ModelConnectionInput = {
      ...input,
      baseUrl: 'https://FIXTURE.invalid:443/v1/',
    };
    const serverStatus: ModelConnectionStatus = {
      ...status,
      baseUrl: noncanonicalInput.baseUrl!.replace(/\/+$/, ''),
    };
    const bridge = modelBridge();

    const receipt = await runModelConnectionCommand(
      { action: 'configure', bridge, input: noncanonicalInput },
      { refresh: async () => serverStatus, isCurrent: () => true },
    );

    expect(receipt).toEqual({ action: 'configure', status: serverStatus });
  });

  it('treats an invalid status URL as unconfirmed without changing the native receipt', async () => {
    const invalidReadback: ModelConnectionStatus = {
      ...status,
      baseUrl: 'not a URL',
    };
    const bridge = modelBridge();

    const receipt = await runModelConnectionCommand(
      { action: 'configure', bridge, input },
      { refresh: async () => invalidReadback, isCurrent: () => true },
    );

    expect(receipt).toEqual({ action: 'configure', status: null });
    expect(bridge.configureModel).toHaveBeenCalledTimes(1);
  });

  it('suppresses a test receipt if its scope expires during the status read', async () => {
    const pendingStatus = deferred<ModelConnectionStatus>();
    const bridge = modelBridge();
    const refresh = vi.fn(() => pendingStatus.promise);
    const gate = createCommandGate();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const command = executeCommand(
      gate,
      (context) =>
        runModelConnectionCommand(
          { action: 'test', bridge },
          {
            refresh,
            isCurrent: context.isCurrent,
          },
        ),
      { onSuccess, onError },
    );

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    gate.invalidate();
    pendingStatus.resolve(status);
    await expect(command).resolves.toBeUndefined();

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(bridge.testModel).toHaveBeenCalledTimes(1);
  });
});
