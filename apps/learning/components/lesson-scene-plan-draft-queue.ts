/**
 * 场景计划草稿的串行保存队列（OMA-024 / 修复 3.3、3.5）。
 *
 * 设计要点（与权威计划 revision 无关的**草稿级**并发控制）：
 * - **串行**：任意时刻只有一个保存在途；期间到来的新快照只覆盖「待保存的最新快照」，
 *   在途请求完成后若快照又变了，就再发一次。这样旧请求不会晚于新请求到达服务端。
 * - **草稿 revision CAS**：每次保存携带 `expectedDraftRevision`（编辑器已知的草稿版本）。
 *   服务端不一致即拒绝（`scene_plan_draft_revision_stale`），旧窗口/乱序写入不会覆盖新编辑。
 * - **冲突与未知结果**：保留本地最新快照，不自动采纳另一窗口的 revision 后覆盖写入。
 *   等待用户重新读取、比较或明确重试；失败不表示内容已保存。
 * - 状态机 `idle/pending/saving/saved/failed` 供界面如实展示，不把「已调用」当「已确认」。
 */

import type { PlanSceneDto } from '@sew/study-contracts';

export type DraftSaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed';

export interface DraftSnapshot {
  baseRevision: number;
  baseDigest: string | null;
  scenes: PlanSceneDto[];
}

export interface DraftSaveOutcome {
  draftRevision: number;
}

export interface DraftSaveError {
  /** 服务端判定为草稿版本冲突时给出当前草稿 revision，供调用方采纳后重试。 */
  conflictRevision?: number;
}

export interface DraftSaveQueueDeps {
  /** 真正发起保存；resolve 返回服务端确认的新草稿 revision。 */
  send: (snapshot: DraftSnapshot, expectedDraftRevision: number) => Promise<DraftSaveOutcome>;
  /** 解析错误：冲突时给出服务端当前草稿 revision。 */
  classifyError: (error: unknown) => DraftSaveError;
  onStateChange?: (state: DraftSaveState) => void;
  /** 可选：每次成功保存后回调，供界面更新「已保存」提示（含 revision）。 */
  onSaved?: (revision: number) => void;
  onError?: (error: unknown) => void;
}

export interface DraftSaveQueue {
  /** 提交最新快照；串行保存，保留最后快照。 */
  submit(snapshot: DraftSnapshot): void;
  /** 当前已知的草稿 revision（0 表示尚无草稿）。 */
  knownRevision(): number;
  state(): DraftSaveState;
  /** 是否有未落库的编辑（含在途）。 */
  hasUnsaved(): boolean;
  /** 立即保存最后快照并等待其完成；离开页面/卸载时调用。 */
  flush(): Promise<void>;
  /** 采纳服务端权威 revision（例如重新载入草稿后）。 */
  adoptRevision(revision: number): void;
  /** 保存计划成功或显式丢弃草稿后：清空待保存内容并归零基线。 */
  reset(revision?: number): void;
}

export const createDraftSaveQueue = (deps: DraftSaveQueueDeps): DraftSaveQueue => {
  /** reset 后旧请求的回调不得恢复已丢弃的内容或更新新基线。 */
  let epoch = 0;
  let revision = 0;
  let state: DraftSaveState = 'idle';
  /** 待保存的最新快照；null 表示当前无未保存编辑。 */
  let pending: DraftSnapshot | null = null;
  let inFlight: Promise<void> | null = null;

  const setState = (next: DraftSaveState): void => {
    if (state === next) return;
    state = next;
    deps.onStateChange?.(next);
  };

  const drain = async (): Promise<void> => {
    while (pending) {
      const snapshot = pending;
      const sentEpoch = epoch;
      pending = null;
      setState('saving');
      try {
        const result = await deps.send(snapshot, revision);
        if (sentEpoch !== epoch) continue;
        revision = result.draftRevision;
        deps.onSaved?.(revision);
        // 保存期间若又有新快照，循环继续（串行，最后快照获胜）。
        setState(pending ? 'pending' : 'saved');
      } catch (error) {
        if (sentEpoch !== epoch) continue;
        // 冲突不自动采用另一窗口的 revision；保留本地内容，等待用户重新比较。
        // 非冲突失败（网络/未知）或冲突重试超限：保留最后快照待下次重试，不把失败当已保存。
        if (!pending) pending = snapshot;
        setState('failed');
        deps.onError?.(error);
        return;
      }
    }
    if (state !== 'saved' && state !== 'idle') setState('saved');
  };

  const kick = (): void => {
    if (inFlight) return;
    inFlight = drain().finally(() => {
      inFlight = null;
      // drain 可能因失败提前返回而仍有 pending；交给显式 submit/flush 再触发，避免忙等。
    });
  };

  return {
    submit(snapshot) {
      pending = snapshot;
      if (state !== 'saving') setState('pending');
      kick();
    },
    knownRevision: () => revision,
    state: () => state,
    hasUnsaved: () => pending !== null || inFlight !== null,
    async flush() {
      // 若在途，先等它完成；再确保最后快照被提交。
      while (inFlight) await inFlight;
      if (pending) {
        kick();
        while (inFlight) await inFlight;
      }
    },
    adoptRevision(next) {
      revision = Math.max(revision, next);
    },
    reset(next = 0) {
      epoch += 1;
      revision = next;
      pending = null;
      setState('idle');
    },
  };
};
