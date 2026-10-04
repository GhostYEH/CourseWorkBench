/**
 * 原生 IPC 合同（《Electron 开发设计》第 5 节）。
 *
 * 只暴露白名单方法：窗口、目录/文件选择、授权、原文副本打开、凭据配置与服务控制。
 * 知识/审核/计划/课程等业务通过同源 HTTP 领域接口进入，不注册进 IPC。
 *
 * 通道名放在同目录的 `ipc-channels.json`。主进程与渲染层从此合同读取，
 * 沙箱 preload 则由 scripts/generate-preload.mjs 将同一份名单内嵌到生成文件，
 * 避免加载沙箱不允许的工作区模块。
 */

import channels from '../ipc-channels.json';
import type { MaterialOriginalOpenInput, RecentProjectDto } from './api';

export const IPC = channels;

export type IpcChannel = (typeof channels)[keyof typeof channels];

/** preload 暴露给渲染层的唯一对象名。渲染层不能拿到任意 invoke/send。 */
export const PRELOAD_BRIDGE_NAME = 'sewNative';

export interface ServiceReadyPayload {
  origin: string;
  port: number;
  /** 应用会话凭据：只经受控通道传递，不放 URL、日志或 NEXT_PUBLIC 配置。 */
  sessionToken: string;
  /** 主进程确认的服务身份，渲染层只做展示与同源校验。 */
  serviceInstanceId: string;
}

export interface ServiceStatusPayload {
  state: 'starting' | 'ready' | 'crashed' | 'stopped';
  message: string;
  port: number | null;
  /** 单调递增，避免 hydration 快照覆盖之后收到的状态事件。 */
  revision: number;
}

export interface OpenedProjectPayload {
  projectId: string;
  displayName: string;
  /** 打开代次：同路径重开也重新分配。 */
  generation: number;
  /** 仅用于界面展示；渲染层不能把任意磁盘路径提交给 HTTP API。 */
  displayPath: string;
  formatVersion: number;
}

export interface PickedFilesPayload {
  files: Array<{ path: string; name: string; size: number }>;
}

/**
 * 打开材料版本原文副本的请求。与本地服务的内部入口共用同一形状（含 scope）：
 * 渲染层只提交标识与版本，不能提交磁盘路径；副本位置由服务决定，
 * 主进程复验归属后才交给系统打开。
 */
export type OpenMaterialOriginalRequest = MaterialOriginalOpenInput;

export interface OpenMaterialOriginalResult {
  /** 归档时记录的文件名字面，仅用于展示；未登记时为 null。 */
  displayName: string | null;
  /** 指定段落在原文中的行号范围；未指定段落时为 null。 */
  lineStart: number | null;
  lineEnd: number | null;
}

export interface ServiceStatePayload {
  status: ServiceStatusPayload;
  /** 会话凭据只在已 ready 时返回，controlToken 永远不属于 renderer 契约。 */
  ready: ServiceReadyPayload | null;
}

/**
 * IPC 方法族的参数与返回类型（N3）。
 *
 * 主进程的 handler 注册表与渲染层的 NativeBridge 都以此为准：
 * handler 的入参/返回值受编译期约束，避免声明与实现漂移。
 * 通道名（`channels`）与这里的方法名一一对应，`pnpm check:code` 会核对。
 */
export interface IpcContract {
  projectCreate: { args: []; result: OpenedProjectPayload | null };
  projectOpen: { args: []; result: OpenedProjectPayload | null };
  projectClose: { args: []; result: void };
  projectRecent: { args: []; result: RecentProjectDto[] };
  materialsPickFiles: { args: []; result: PickedFilesPayload };
  materialsOpenOriginal: { args: [request: OpenMaterialOriginalRequest]; result: OpenMaterialOriginalResult };
  exportsPickTarget: { args: [defaultName: string]; result: string | null };
  exportsBackupProject: { args: []; result: string | null };
  preferencesRead: { args: []; result: unknown };
  preferencesSave: { args: [value: unknown]; result: unknown };
  modelsConfigure: { args: [value: unknown]; result: void };
  modelsTest: { args: []; result: { ok: boolean; message: string } };
  getServiceState: { args: []; result: ServiceStatePayload };
  windowMinimize: { args: []; result: void };
  windowToggleMaximize: { args: []; result: void };
  windowClose: { args: []; result: void };
}

export type IpcMethod = keyof IpcContract;

/** 主进程 handler 注册表：每个方法必须实现，返回值类型受 IpcContract 约束。 */
export type IpcHandlerMap = {
  [M in IpcMethod]: (...args: IpcContract[M]['args']) => IpcContract[M]['result'] | Promise<IpcContract[M]['result']>;
};

/** 通道名 → 方法名 的映射，供实现与合同一致性检查使用。 */
export const IPC_METHOD_CHANNEL: Record<IpcMethod, IpcChannel> = {
  projectCreate: channels.projectCreate,
  projectOpen: channels.projectOpen,
  projectClose: channels.projectClose,
  projectRecent: channels.projectRecent,
  materialsPickFiles: channels.materialsPickFiles,
  materialsOpenOriginal: channels.materialsOpenOriginal,
  exportsPickTarget: channels.exportsPickTarget,
  exportsBackupProject: channels.exportsBackupProject,
  preferencesRead: channels.preferencesRead,
  preferencesSave: channels.preferencesSave,
  modelsConfigure: channels.modelsConfigure,
  modelsTest: channels.modelsTest,
  getServiceState: channels.serviceStatus,
  windowMinimize: channels.windowMinimize,
  windowToggleMaximize: channels.windowToggleMaximize,
  windowClose: channels.windowClose,
};

export interface NativeBridge {
  readonly platform: string;
  onServiceReady(handler: (payload: ServiceReadyPayload) => void): () => void;
  onServiceStatus(handler: (payload: ServiceStatusPayload) => void): () => void;
  getServiceState(): Promise<ServiceStatePayload>;
  onProjectChanged(handler: (payload: OpenedProjectPayload | null) => void): () => void;

  projectCreate(): Promise<OpenedProjectPayload | null>;
  projectOpen(): Promise<OpenedProjectPayload | null>;
  projectClose(): Promise<void>;
  projectRecent(): Promise<RecentProjectDto[]>;

  pickMaterials(): Promise<PickedFilesPayload>;

  /** 打开项目内归档的材料原文副本；原文未归档时返回明确错误而不是静默无操作。 */
  openMaterialOriginal(request: OpenMaterialOriginalRequest): Promise<OpenMaterialOriginalResult>;

  pickExportTarget(defaultName: string): Promise<string | null>;
  backupProject(): Promise<string | null>;

  readPreferences(): Promise<unknown>;
  savePreferences(value: unknown): Promise<unknown>;

  configureModel(value: unknown): Promise<void>;
  testModel(): Promise<{ ok: boolean; message: string }>;

  minimizeWindow(): void;
  toggleMaximizeWindow(): void;
  closeWindow(): void;
}
