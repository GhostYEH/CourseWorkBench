import { describe, expect, it, vi } from 'vitest';
import type { NativeBridge, ServiceReadyPayload, ServiceStatePayload, ServiceStatusPayload } from '@sew/study-contracts';
import { subscribeService } from '../apps/learning/lib/service-subscription';

const setup = () => {
  let publishStatus!: (payload: ServiceStatusPayload) => void;
  let publishReady!: (payload: ServiceReadyPayload) => void;
  const pendingSnapshots: Array<(value: ServiceStatePayload) => void> = [];
  const resolveSnapshot = (value: ServiceStatePayload) => pendingSnapshots.shift()!(value);
  const status = vi.fn();
  const token = vi.fn();
  const unsubscribeReady = vi.fn();
  const unsubscribeStatus = vi.fn();
  const bridge: Pick<NativeBridge, 'onServiceReady' | 'onServiceStatus' | 'getServiceState'> = {
    onServiceReady: (handler) => { publishReady = handler; return unsubscribeReady; },
    onServiceStatus: (handler) => { publishStatus = handler; return unsubscribeStatus; },
    getServiceState: () => new Promise((resolve) => { pendingSnapshots.push(resolve); }),
  };
  const dispose = subscribeService(bridge, status, token);
  return { status, token, publishStatus, publishReady, resolveSnapshot, dispose, unsubscribeReady, unsubscribeStatus };
};
const ready: ServiceReadyPayload = {
  origin: 'http://127.0.0.1:43127', port: 43127,
  sessionToken: 'old-session', serviceInstanceId: 'old-service',
};

describe('renderer service subscription', () => {
  it('restores a crash that happened before the component subscribed', async () => {
    const test = setup();
    const crashed = { state: 'crashed' as const, message: 'stopped', port: null, revision: 3 };
    test.resolveSnapshot({ status: crashed, ready: null });
    await Promise.resolve();
    expect(test.status).toHaveBeenCalledWith(crashed);
    expect(test.token).toHaveBeenCalledWith(null);
  });

  it('a delayed ready snapshot cannot undo a crash or reinstall its old token', async () => {
    const test = setup();
    test.publishStatus({ state: 'crashed', message: 'stopped', port: null, revision: 3 });
    test.resolveSnapshot({ status: { state: 'ready', message: 'ready', port: ready.port, revision: 2 }, ready });
    await Promise.resolve();
    expect(test.status).toHaveBeenCalledTimes(1);
    expect(test.token).not.toHaveBeenCalledWith(ready.sessionToken);
  });

  it('cleans both listeners and ignores an in-flight snapshot after unmounting', async () => {
    const test = setup();
    test.dispose();
    test.resolveSnapshot({ status: { state: 'ready', message: 'ready', port: ready.port, revision: 2 }, ready });
    await Promise.resolve();
    expect(test.unsubscribeReady).toHaveBeenCalledOnce();
    expect(test.unsubscribeStatus).toHaveBeenCalledOnce();
    expect(test.status).not.toHaveBeenCalled();
    expect(test.token).not.toHaveBeenCalled();
  });

  it('a delayed ready event cannot directly reinstall a token after a crash', async () => {
    const test = setup();
    const crashed = { state: 'crashed' as const, message: 'stopped', port: null, revision: 3 };
    test.publishStatus(crashed);
    test.publishReady(ready);
    test.resolveSnapshot({ status: { state: 'ready', message: 'ready', port: ready.port, revision: 2 }, ready });
    test.resolveSnapshot({ status: crashed, ready: null });
    await Promise.resolve();
    expect(test.token).not.toHaveBeenCalledWith(ready.sessionToken);
    expect(test.status).toHaveBeenLastCalledWith(crashed);
  });
});
