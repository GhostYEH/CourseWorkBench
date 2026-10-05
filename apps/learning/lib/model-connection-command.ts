import {
  modelTestResultSchema,
  type ModelConnectionInput,
  type ModelConnectionStatus,
  type ModelTestResult,
  type NativeBridge,
} from '@sew/study-contracts';

type ModelBridge = Pick<NativeBridge, 'configureModel' | 'testModel'>;

type CommandDependencies = {
  refresh: () => Promise<ModelConnectionStatus | undefined>;
  isCurrent: () => boolean;
};

export type ModelConnectionCommandReceipt =
  | { action: 'configure'; status: ModelConnectionStatus | null }
  | { action: 'test'; diagnostic: ModelTestResult; statusRefreshed: boolean };

type ModelConnectionCommand =
  | { action: 'configure'; bridge: ModelBridge; input: ModelConnectionInput }
  | { action: 'test'; bridge: ModelBridge };

const readStatus = async (
  refresh: CommandDependencies['refresh'],
): Promise<ModelConnectionStatus | null> => {
  try {
    return (await refresh()) ?? null;
  } catch {
    return null;
  }
};

const normalizeBaseUrl = (baseUrl: string): string | null => {
  try {
    return new URL(baseUrl).href.replace(/\/+$/, '');
  } catch {
    return null;
  }
};

/** Keeps the native receipt independent from the best-effort status read that follows it. */
export const runModelConnectionCommand = async (
  command: ModelConnectionCommand,
  dependencies: CommandDependencies,
): Promise<ModelConnectionCommandReceipt | undefined> => {
  if (command.action === 'configure') {
    await command.bridge.configureModel(command.input);
    if (!dependencies.isCurrent()) return undefined;
    const observed = await readStatus(dependencies.refresh);
    if (!dependencies.isCurrent()) return undefined;
    const expectedBaseUrl = normalizeBaseUrl(command.input.baseUrl);
    const observedBaseUrl = observed?.baseUrl ? normalizeBaseUrl(observed.baseUrl) : null;
    const status =
      observed?.configured &&
      expectedBaseUrl !== null &&
      observedBaseUrl === expectedBaseUrl &&
      observed.model === command.input.model
        ? observed
        : null;
    return { action: 'configure', status };
  }

  const diagnostic = modelTestResultSchema.parse(await command.bridge.testModel());
  if (!dependencies.isCurrent()) return undefined;
  const status = await readStatus(dependencies.refresh);
  if (!dependencies.isCurrent()) return undefined;
  return { action: 'test', diagnostic, statusRefreshed: status !== null };
};
