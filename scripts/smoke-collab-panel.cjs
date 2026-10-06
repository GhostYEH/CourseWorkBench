/* Real online-collab UI smoke. The caller owns an authenticated temporary profile/project.
 * The collaboration service is intentionally NOT configured for this suite, so the panel must
 * keep showing the "cannot invite online" boundary. This suite does not simulate another identity
 * and does not claim two-device acceptance (that is COLLAB-EVAL-01, still unverified).
 * Network diagnostics retain counts, timings and scope comparisons only.
 */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const delay = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

module.exports = async ({
  window,
  origin,
  serviceRequest,
  waitForText,
  waitForUrl,
  cover,
  markStep = () => {},
}) => {
  const evaluate = async (script, phase) => {
    try {
      return await window.webContents.executeJavaScript(script);
    } catch {
      throw new Error(`collab renderer execution failed (${phase})`);
    }
  };
  const wait = async (script, phase) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await evaluate(script, phase)) return;
      await delay(100);
    }
    throw new Error(`collab renderer condition timed out (${phase})`);
  };
  const click = async (selector, phase) => {
    const encoded = JSON.stringify(selector);
    await wait(
      `Boolean(document.querySelector(${encoded})) && !document.querySelector(${encoded}).disabled`,
      `${phase}:enabled`,
    );
    await evaluate(`document.querySelector(${encoded}).click()`, phase);
  };

  const identity = await serviceRequest('GET', '/api/study/identity');
  const state = await serviceRequest('GET', '/api/study/state');
  const scope = {
    'x-sew-project-id': state.project.projectId,
    'x-sew-generation': String(state.project.generation),
  };
  assert(identity.canInvite === false, 'local profile unexpectedly allows online invitation');

  // Save through the real profile form so the online identity consumes a persisted nickname.
  markStep('collab-panel:profile-form');
  await window.loadURL(`${origin}/profile`);
  await wait('Boolean(document.querySelector("[data-learner-name]"))', 'profile-ready');
  await evaluate(
    `(() => {
      const input = document.querySelector('[data-learner-name]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '协作面板运行验证');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
    'profile-name',
  );
  await click('[data-save-learner-name]', 'profile-save');
  await waitForText('昵称已保存，UID 保持不变。', 'profile form did not confirm nickname save');
  const renamed = await serviceRequest('GET', '/api/study/identity');
  assert(
    renamed.uid === identity.uid && renamed.displayName === '协作面板运行验证',
    'profile form did not persist nickname under the original identity',
  );
  cover(
    'collab setup: real profile nickname form saved; UID preserved; online invitation disabled',
  );

  const network = window.webContents.debugger;
  const ownsDebugger = !network.isAttached();
  if (ownsDebugger) network.attach('1.3');
  const records = [];
  const pending = new Map();
  let phase = 'load';
  const onMessage = (_event, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      const request = params.request;
      const url = new URL(request.url);
      if (url.origin !== origin || !url.pathname.startsWith('/api/study/collab/')) return;
      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
      );
      const record = {
        phase,
        at: Date.now(),
        online: url.pathname === '/api/study/collab/online',
        method: request.method,
        scoped:
          headers['x-sew-project-id'] === scope['x-sew-project-id'] &&
          headers['x-sew-generation'] === scope['x-sew-generation'],
        completed: false,
        failed: false,
        status: null,
      };
      records.push(record);
      pending.set(params.requestId, record);
    } else if (method === 'Network.responseReceived') {
      const record = pending.get(params.requestId);
      if (record) record.status = params.response.status;
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const record = pending.get(params.requestId);
      if (record) {
        record.completed = true;
        record.failed = method === 'Network.loadingFailed';
        pending.delete(params.requestId);
      }
    }
  };
  network.on('message', onMessage);
  await network.sendCommand('Network.enable');
  try {
    markStep('collab-panel:initial-render');
    await window.loadURL(`${origin}/workbench/collab`);
    await wait('Boolean(document.querySelector("[data-collab-panel]"))', 'panel-ready');
    await waitForText('不能联网邀请', 'unconfigured collab panel did not show the online boundary');
    assert(
      await evaluate(
        `document.querySelector('[data-collab-panel]').textContent.includes('不能联网邀请') &&
        document.querySelector('#collab-self-uid')?.readOnly &&
        document.querySelector('#collab-self-uid')?.value === ${JSON.stringify(identity.uid)}`,
        'online-boundary',
      ),
      'collab panel did not show the online boundary and read-only current identity',
    );
    assert(
      await evaluate(
        'document.querySelector("button[data-collab-invite]")?.disabled',
        'invite-empty',
      ),
      'empty project enabled invitation without a published frozen lesson',
    );
    // 未配置在线服务时「开通在线身份」不可点：不能在没有服务地址时伪报在线可用。
    assert(
      await evaluate(
        'document.querySelector("button[data-collab-enable]")?.disabled',
        'enable-disabled',
      ),
      'collab panel enabled online identity without a configured collaboration service',
    );
    cover(
      'collab panel renders online boundary, immutable self UID and unavailable online actions',
    );

    // Observe an idle period. State writes must not restart the effect loop.
    phase = 'poll';
    markStep('collab-panel:polling');
    await delay(12500);
    const polls = records.filter(
      (record) => record.phase === 'poll' && record.online && record.method === 'GET',
    );
    const intervals = polls.slice(1).map((record, index) => record.at - polls[index].at);
    assert(
      polls.length >= 2 && polls.length <= 3,
      'collab idle polling count is outside a 5-second cadence',
    );
    assert(
      intervals.every((ms) => ms >= 4000 && ms <= 7000),
      'collab refresh state restarted polling or polling cadence stalled',
    );
    assert(
      records.every((record) => record.scoped),
      'a renderer collab read omitted the current project scope headers',
    );
    assert(
      records.every((record) => record.completed && !record.failed && record.status === 200),
      'an online collab renderer request failed or remained pending',
    );
    cover(
      `collab requests scoped=true; idlePollCount=${polls.length}; fiveSecondCadence=true; onlineBoundary=true`,
    );

    // Client navigation keeps the renderer alive and exercises React unmount cleanup.
    phase = 'leave';
    markStep('collab-panel:navigate-away');
    await click('a[href="/workbench"]', 'navigate-workbench');
    await waitForUrl(
      (url) => url.endsWith('/workbench'),
      'collab client navigation did not finish',
    );
    await wait('!document.querySelector("[data-collab-panel]")', 'panel-unmounted');
    const countAtUnmount = records.length;
    await delay(6500);
    assert(
      records.length === countAtUnmount,
      'collab requests continued after client navigation unmounted the panel',
    );
    cover(
      'collab lifecycle: client navigation unmounted panel; no collab requests during following 6.5 seconds',
    );
    markStep('collab-panel:completed', {
      collabDiagnostics: {
        allRequestsScoped: true,
        requestCount: records.length,
        idlePollCount: polls.length,
        fiveSecondCadence: true,
        requestsAfterUnmount: 0,
        onlineConfigured: false,
      },
    });
  } finally {
    network.removeListener('message', onMessage);
    if (ownsDebugger && network.isAttached()) network.detach();
  }
};
