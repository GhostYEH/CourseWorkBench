import type { NativeBridge, ServiceStatusPayload } from '@sew/study-contracts';

type ServiceBridge = Pick<NativeBridge, 'onServiceReady' | 'onServiceStatus' | 'getServiceState'>;

/** Subscribe before reading the snapshot; a delayed snapshot cannot replace newer events. */
export const subscribeService = (
  bridge: ServiceBridge,
  onStatus: (status: ServiceStatusPayload) => void,
  onToken: (token: string | null) => void,
): (() => void) => {
  let active = true;
  let revision = -1;
  const applyStatus = (status: ServiceStatusPayload): boolean => {
    if (!active || status.revision < revision) return false;
    revision = status.revision;
    if (status.state !== 'ready') onToken(null);
    onStatus(status);
    return true;
  };
  const readSnapshot = () => {
    if (!active) return;
    void bridge.getServiceState().then((snapshot) => {
      if (!applyStatus(snapshot.status)) return;
      if (snapshot.status.state === 'ready' && snapshot.ready) onToken(snapshot.ready.sessionToken);
    }).catch(() => { /* No internal IPC diagnostic belongs in the renderer. */ });
  };
  // Ready events may themselves be delayed by loadURL. Their credentials are
  // never accepted directly; retrieve the current revision-bound state instead.
  const unsubscribeReady = bridge.onServiceReady(readSnapshot);
  const unsubscribeStatus = bridge.onServiceStatus((status) => {
    if (applyStatus(status) && status.state === 'ready') readSnapshot();
  });
  readSnapshot();
  return () => {
    active = false;
    unsubscribeReady();
    unsubscribeStatus();
  };
};
