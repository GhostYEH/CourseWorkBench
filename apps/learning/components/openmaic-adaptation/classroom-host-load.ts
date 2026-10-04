/**
 * Copied and adapted from OpenMAIC components/classroom/ClassroomSurface.tsx,
 * loadClassroom page-mode branches (lines 103-187).
 * Copyright (c) 2026 THU-MAIC. MIT; see ./LICENSE.
 *
 * The original outcome control flow and stale-result guards are retained.
 * The document/media/ownership dependency graph is replaced with a service-
 * scoped load port. That port must check project generation, source admission,
 * and assets before returning ready. Generation/edit/media-production ports
 * are unavailable in M0, not silently successful no-op implementations.
 */
export type OpenMaicHostLoadResult =
  | { outcome: 'ready'; classroomId: string }
  | { outcome: 'absent' }
  | { outcome: 'unavailable'; error?: string }
  | { outcome: 'failed'; error: string }
  | { outcome: 'cancelled' };

export type ClassroomHostLoadOutcome = 'loaded' | 'absent' | 'failed' | 'cancelled';
export const LOAD_UNAVAILABLE_ERROR = '课堂暂时不可用，请检查项目与资源后重试。';

/** Copied/adapted progressive-load-policy.ts:15-37; identity fence also applies to the page host. */
export function resolveOpenMaicClassroomView({
  loading, error, notFound, loadedIdentity, identity,
}: {
  loading: boolean;
  error: string | null;
  notFound: boolean;
  loadedIdentity: string | null;
  identity: string;
}): 'loading' | 'not-found' | 'error' | 'stage' {
  if (loading || (!error && !notFound && loadedIdentity !== identity)) {
    return 'loading';
  }
  if (notFound) return 'not-found';
  if (error) return 'error';
  return 'stage';
}

export async function loadOpenMaicClassroom({
  classroomId,
  isCurrent,
  loadDocumentAndAssets,
  setNotFound,
  setLoadUnavailable,
  setError,
  setLoading,
}: {
  classroomId: string;
  isCurrent: () => boolean;
  loadDocumentAndAssets: (isCurrent: () => boolean) => Promise<OpenMaicHostLoadResult>;
  setNotFound: (value: boolean) => void;
  setLoadUnavailable: (value: boolean) => void;
  setError: (value: string | null) => void;
  setLoading: (value: boolean) => void;
}): Promise<ClassroomHostLoadOutcome> {
  try {
    const loadResult = await loadDocumentAndAssets(isCurrent);
    if (!isCurrent()) return 'cancelled';

    // Positive absence only; transport or admission failures stay retryable.
    if (loadResult.outcome === 'absent') {
      setNotFound(true);
      return 'absent';
    }

    if (loadResult.outcome === 'unavailable') {
      setLoadUnavailable(true);
      setError(LOAD_UNAVAILABLE_ERROR);
      setLoading(false);
      return 'failed';
    }

    if (loadResult.outcome === 'cancelled') return 'cancelled';
    if (loadResult.outcome === 'failed') {
      // The scoped port returns errors instead of mutating the surface.
      setError(loadResult.error);
      return 'failed';
    }

    // Defensive: a ready load for the wrong course must not become not-found.
    if (loadResult.classroomId !== classroomId) {
      setLoadUnavailable(true);
      setError(LOAD_UNAVAILABLE_ERROR);
      setLoading(false);
      return 'failed';
    }
    return 'loaded';
  } catch {
    if (isCurrent()) {
      setLoadUnavailable(false);
      // Exception messages from external ports may contain filesystem paths.
      setError('课堂加载失败，请检查项目与资源后重试。');
      setLoading(false);
    }
    return isCurrent() ? 'failed' : 'cancelled';
  } finally {
    // Upstream runClassroomLoad clears loading; our scoped port has no setters.
    if (isCurrent()) setLoading(false);
  }
}
