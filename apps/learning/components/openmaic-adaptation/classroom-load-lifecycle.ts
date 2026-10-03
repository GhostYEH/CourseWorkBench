/**
 * Independently authored M0 extraction of the load/apply boundary in
 * OpenMAIC lib/classroom/load-classroom.ts::runClassroomLoad. It keeps the
 * upstream positive-absence vs unavailable distinction, token checks before
 * applying loaded data, and explicit outcomes; its broad IndexedDB/fallback/
 * hydration pipeline is deliberately replaced by scoped HttpDocumentStore.
 */
export type ClassroomLoadOutcome<T> =
  | { outcome: 'ready'; document: T }
  | { outcome: 'absent' }
  | { outcome: 'unavailable'; error: unknown }
  | { outcome: 'failed'; error: unknown }
  | { outcome: 'cancelled' };

export async function runClassroomLoad<T>({
  isCurrent,
  loadFromAuthoritativeStore,
  applyDocument,
}: {
  isCurrent: () => boolean;
  loadFromAuthoritativeStore: () => Promise<T | undefined>;
  applyDocument: (document: T) => void | Promise<void>;
}): Promise<ClassroomLoadOutcome<T>> {
  let document: T | undefined;
  try {
    document = await loadFromAuthoritativeStore();
  } catch (error) {
    if (!isCurrent()) return { outcome: 'cancelled' };
    return { outcome: 'unavailable', error };
  }
  if (!isCurrent()) return { outcome: 'cancelled' };
  if (!document) return { outcome: 'absent' };
  try {
    await applyDocument(document);
    if (!isCurrent()) return { outcome: 'cancelled' };
    return { outcome: 'ready', document };
  } catch (error) {
    if (!isCurrent()) return { outcome: 'cancelled' };
    return { outcome: 'failed', error };
  }
}
