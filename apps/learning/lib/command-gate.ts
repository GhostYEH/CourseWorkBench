export interface CommandContext {
  signal: AbortSignal;
  isCurrent: () => boolean;
  isActive: () => boolean;
  commit: (apply: () => void) => void;
}

/** One in-flight command per view; invalidation revokes results even if fetch ignores abort. */
export const createCommandGate = () => {
  let revision = 0;
  let active = true;
  let pending: AbortController | null = null;
  return {
    activate() { active = true; },
    invalidate() {
      active = false;
      revision += 1;
      pending?.abort();
      pending = null;
    },
    cancel() { pending?.abort(); },
    begin(): (CommandContext & { finish: () => void }) | null {
      if (!active || pending) return null;
      const controller = new AbortController();
      const started = revision;
      pending = controller;
      const isActive = () => active && revision === started && pending === controller;
      const isCurrent = () => isActive() && !controller.signal.aborted;
      return {
        signal: controller.signal,
        isActive,
        isCurrent,
        commit: apply => { if (isCurrent()) apply(); },
        finish: () => { if (isActive()) pending = null; },
      };
    },
  };
};
