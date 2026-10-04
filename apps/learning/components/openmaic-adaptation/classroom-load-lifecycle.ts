/**
 * M0 load/apply port of OpenMAIC
 * lib/classroom/load-classroom.ts::runClassroomLoad.
 * Copyright (c) 2026 THU-MAIC. MIT; see ./LICENSE.
 *
 * The cancellation guards and ready/absent/failed branches are retained from
 * upstream lines 157-212 and 279-287. The load ports, generic result payload,
 * and unavailable error retention are independently authored. The upstream
 * IndexedDB/server fallback/media/roster graph is replaced by one scoped
 * HttpDocumentStore read into SQLite authority; this is not the full host.
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
    return isCurrent() ? { outcome: 'failed', error } : { outcome: 'cancelled' };
  }
}
