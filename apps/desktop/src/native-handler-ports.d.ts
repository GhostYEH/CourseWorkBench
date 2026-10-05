import type {
  IpcContract,
  IpcHandlerMap,
  IpcMethod,
  OpenedProjectPayload,
  ServiceReadyPayload,
  ServiceStatusPayload,
} from '../../../packages/study-contracts/src/ipc';
import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from 'electron';

export type SendMethod = 'windowMinimize' | 'windowToggleMaximize' | 'windowClose';
export type InvokeMethod = Exclude<IpcMethod, SendMethod>;
export type InvokeHandlers = Pick<IpcHandlerMap, InvokeMethod>;
export type SendHandlers = Pick<IpcHandlerMap, SendMethod>;
export type NoArgumentMethod = {
  [M in IpcMethod]: IpcContract[M]['args'] extends [] ? M : never;
}[IpcMethod];
export type Scope = { projectId: string; generation: number };
export type RecordValue = Record<string, unknown>;

// Only the capabilities used by the native handlers are described here. HTTP
// payloads and renderer input remain unknown until checked by the handler.
export interface WindowPort {
  webContents: object;
  minimize(): void;
  isMaximized(): boolean;
  unmaximize(): void;
  maximize(): void;
  close(): void;
}
export interface CallerEvent {
  sender: object;
  senderFrame: { url: string; parent: object | null } | null;
}
export interface NativeHandlerPorts {
  ipcMain: {
    handle(
      channel: string,
      callback: (event: CallerEvent, ...args: unknown[]) => Promise<unknown>,
    ): void;
    on(channel: string, callback: (event: CallerEvent, ...args: unknown[]) => void): void;
  };
  dialog: {
    showOpenDialog(
      window: WindowPort | null,
      options: OpenDialogOptions,
    ): Promise<OpenDialogReturnValue>;
    showSaveDialog(
      window: WindowPort | null,
      options: SaveDialogOptions,
    ): Promise<SaveDialogReturnValue>;
  };
  channels: Record<Exclude<IpcMethod, 'getServiceState'> | 'serviceStatus', string> & {
    getServiceState?: string;
  };
  getWindow(): WindowPort | null;
  service: {
    request(method: string, endpoint: string, body?: unknown, timeout?: number): Promise<unknown>;
    getReady(): (ServiceReadyPayload & { controlToken: string }) | null;
    getKnownOrigin(): string | null;
    getStatus(): ServiceStatusPayload;
  };
  projects: {
    open(directory: string): Promise<unknown>;
    close(): Promise<void>;
    current(): OpenedProjectPayload | null;
    scopeOf(): Scope;
    sameScope(left: Scope, right: Scope): boolean;
    beginGrant(): () => void;
  };
  settings: {
    readRecentProjects(): unknown[];
    saveModelCredentials(config: unknown): { persisted: boolean };
  };
  shell: { openPath(filename: string): Promise<string> };
}

export type OpenedProjectResult = IpcContract['projectOpen']['result'];
