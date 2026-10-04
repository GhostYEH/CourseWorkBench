'use client';

/**
 * Actual OpenMAIC ClassroomSurface page-mode host lifecycle extraction.
 * Copyright (c) 2026 THU-MAIC. MIT; see ./LICENSE.
 *
 * Copied/adapted loadClassroom, retryClassroom, useEffect loadUntilAvailable and
 * unmount branches from components/classroom/ClassroomSurface.tsx:103-297.
 * The pane-availability retry graph is excluded (M0 uses the page surface).
 * HttpDocumentStore/SQLite assets and service admission enter through a scoped
 * load port; ownership-based generation, agents, narration adoption, and media
 * generation have no enabled ports here. The ready fence replaces the original
 * stage-store identity view fence with both classroom and project identity.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadOpenMaicClassroom, resolveOpenMaicClassroomView, type ClassroomHostLoadOutcome, type OpenMaicHostLoadResult } from './classroom-host-load';
import { createClassroomLifecycle } from './host-lifecycle';

export type { OpenMaicHostLoadResult } from './classroom-host-load';

export function useOpenMaicClassroomLoad({
  classroomId,
  identity,
  loadDocumentAndAssets,
  releaseDocumentAndAssets,
}: {
  classroomId: string;
  identity: string;
  loadDocumentAndAssets: (isCurrent: () => boolean) => Promise<OpenMaicHostLoadResult>;
  releaseDocumentAndAssets: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadUnavailable, setLoadUnavailable] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null);
  const activeClassroomIdRef = useRef<string | null>(null);
  const loadEpochRef = useRef(0);
  const loadTokens = useRef(createClassroomLifecycle());
  // Fence the render immediately on a project switch, before passive cleanup.
  const renderedIdentityRef = useRef(identity);
  renderedIdentityRef.current = identity;

  const loadClassroom = useCallback(
    async (isEffectCurrent: () => boolean): Promise<ClassroomHostLoadOutcome> => {
      const loadToken = loadTokens.current.claim();
      const isCurrent = () => isEffectCurrent() && loadToken.isCurrent();
      return loadOpenMaicClassroom({
        classroomId,
        isCurrent,
        loadDocumentAndAssets,
        setError,
        setLoading,
        setNotFound,
        setLoadUnavailable,
      });
    },
    [classroomId, loadDocumentAndAssets],
  );

  const retryClassroom = useCallback(() => {
    const loadEpoch = loadEpochRef.current + 1;
    loadEpochRef.current = loadEpoch;
    const isCurrent = () =>
      activeClassroomIdRef.current === classroomId &&
      renderedIdentityRef.current === identity &&
      loadEpochRef.current === loadEpoch;
    setError(null);
    setLoadUnavailable(false);
    setNotFound(false);
    setLoading(true);
    setLoadedIdentity(null);
    releaseDocumentAndAssets();

    void loadClassroom(isCurrent).then((outcome) => {
      if (!isCurrent()) return;
      if (outcome === 'loaded') {
        // Admission and project ownership were checked by the scoped port.
        setLoadedIdentity(identity);
        return;
      }
    });
  }, [classroomId, identity, loadClassroom, releaseDocumentAndAssets]);

  useEffect(() => {
    let cancelled = false;
    const loadEpoch = loadEpochRef.current + 1;
    loadEpochRef.current = loadEpoch;
    activeClassroomIdRef.current = classroomId;
    const isCurrent = () =>
      !cancelled &&
      activeClassroomIdRef.current === classroomId &&
      renderedIdentityRef.current === identity &&
      loadEpochRef.current === loadEpoch;

    // Original host unmounts Stage while switching courses: no stale writeback.
    setLoading(true);
    setError(null);
    setLoadUnavailable(false);
    setNotFound(false);
    setLoadedIdentity(null);

    const loadUntilAvailable = async () => {
      if (!isCurrent()) return;
      const outcome = await loadClassroom(isCurrent);
      if (!isCurrent()) return;
      if (outcome === 'loaded') {
        setLoadedIdentity(identity);
      }
    };
    void loadUntilAvailable();

    return () => {
      cancelled = true;
      if (loadEpochRef.current === loadEpoch) {
        loadEpochRef.current += 1;
      }
      if (activeClassroomIdRef.current === classroomId) {
        activeClassroomIdRef.current = null;
      }
      releaseDocumentAndAssets();
    };
  }, [classroomId, identity, loadClassroom, releaseDocumentAndAssets]);

  const view = resolveOpenMaicClassroomView({ loading, error, notFound, loadedIdentity, identity });
  const ready = view === 'stage';
  return { loading: view === 'loading', error, loadUnavailable, notFound, ready, retryClassroom };
}
