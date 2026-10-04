/**
 * OpenMAIC host load-token extraction.
 * Copyright (c) 2026 THU-MAIC. MIT; see ./LICENSE.
 *
 * The claim increment and equality predicate are copied from
 * lib/store/stage.ts:255-261. The upstream singleton counter is scoped to one
 * mounted classroom here: independent hosts must not cancel each other.
 * Lease cancellation and guarded UI commits are independently authored ports
 * for the SQLite/project-generation host, including cleanup after an await.
 */
export interface ClassroomLifecycleLease {
  isCurrent(): boolean;
  cancel(): void;
  applyIfCurrent(apply: () => void): boolean;
}

export function createClassroomLifecycle(): { claim(): ClassroomLifecycleLease } {
  let latestStageSceneLoadToken = 0;

  function claimStageSceneLoadToken(): number {
    latestStageSceneLoadToken += 1;
    return latestStageSceneLoadToken;
  }

  function isCurrentStageSceneLoadToken(token: number): boolean {
    return token === latestStageSceneLoadToken;
  }

  return {
    claim() {
      const loadToken = claimStageSceneLoadToken();
      let cancelled = false;
      const isCurrent = () => !cancelled && isCurrentStageSceneLoadToken(loadToken);
      return {
        isCurrent,
        cancel() { cancelled = true; },
        applyIfCurrent(apply) {
          if (!isCurrent()) return false;
          apply();
          return true;
        },
      };
    },
  };
}
