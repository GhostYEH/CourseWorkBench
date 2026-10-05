/* Scene-plan regression in the real hydrated, sandboxed Electron renderer.
 * Only the caller's temporary HTTP/SQLite fixture is used. No model is called.
 * Mouse helpers remain the same hit-tested CDP helpers used by formal quiz. */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

module.exports = async ({
  window,
  origin,
  serviceRequest,
  waitForText,
  cover,
  execute,
  waitFor,
  click,
  bundleId,
  bundle,
  markStep = () => {},
}) => {
  const state = await serviceRequest('GET', '/api/study/state');
  const scope = { projectId: state.project.projectId, generation: state.project.generation };
  const drafted = await serviceRequest('POST', '/api/study/lessons', {
    scope,
    action: 'draft',
    lessonId: null,
    bundleId,
    title: '场景计划真实交互回归课',
    statementIds: [bundle.statements[0].statementId],
    questionIds: [],
  });
  const lessonId = drafted.lesson.lessonId;
  const version = drafted.lesson.version;
  const rowExpression = `[...document.querySelectorAll('tbody > tr')].find(row => row.firstElementChild?.textContent.trim() === ${JSON.stringify(lessonId)})`;
  const rowSelector = '[data-plan-smoke-row]';
  const markRow = async () =>
    execute(`(() => {
    document.querySelectorAll('[data-plan-smoke-row]').forEach(row => row.removeAttribute('data-plan-smoke-row'));
    const row = ${rowExpression};
    if (!row) throw new Error('计划回归课程行未找到');
    row.setAttribute('data-plan-smoke-row', 'current');
  })()`);
  const clickText = async (text) => {
    await markRow();
    const expression = `[...document.querySelector(${JSON.stringify(rowSelector)}).querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(text)})`;
    await waitFor(`Boolean(${expression}) && !(${expression}).disabled`, `计划控件未就绪：${text}`);
    await execute(`(${expression}).setAttribute('data-plan-smoke-button', 'current')`);
    try {
      await click('[data-plan-smoke-button="current"]', `plan:${text}`);
    } finally {
      await execute(
        `document.querySelector('[data-plan-smoke-button="current"]')?.removeAttribute('data-plan-smoke-button')`,
      );
    }
  };
  // Click and type through Chromium input events, so a rendered textarea with
  // missing React handlers cannot satisfy an editing assertion.
  const typeText = async (selector, text) => {
    await click(selector, 'plan:edit-body');
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers: 2,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
    });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: 2,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
    });
    await window.webContents.debugger.sendCommand('Input.insertText', { text });
    await waitFor(
      `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(text)}`,
      '真实输入未进入计划正文',
    );
  };
  const catalog = () => serviceRequest('GET', '/api/study/lessons');
  const readPlan = async () =>
    (await catalog()).scenePlans.find(
      (plan) => plan.lessonId === lessonId && plan.lessonVersion === version,
    );
  const assertPlan = async (revision, text) => {
    const plan = await readPlan();
    assert(
      plan?.revision === revision &&
        plan.scenes.length === 1 &&
        plan.scenes[0].elements.length === 1 &&
        plan.scenes[0].elements[0].text === text,
      `场景计划权威正文或revision不一致（expected=${revision}）`,
    );
    return plan;
  };
  const save = async (revision, text) => {
    await click(`${rowSelector} [data-scene-plan-save]`, `plan:save-${revision}`);
    await waitFor(
      `(${rowExpression})?.querySelector('[data-scene-plan-save]')?.closest('details').querySelector('summary')?.textContent.includes('修订 ${revision}')`,
      '场景计划保存未刷新服务端revision',
    );
    await markRow();
    return assertPlan(revision, text);
  };
  const poll = async (predicate, message) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error(message);
  };
  // Observe actual HTTP responses; optional response loss happens only after a
  // successful server transaction has returned its committed receipt. Nothing
  // is fulfilled with fabricated response data and no session header is logged.
  const capture = async (action, loseFirstSuccess, operation) => {
    const exchanges = [];
    let protocolError = null;
    const tasks = new Set();
    const onPaused = (_event, method, params) => {
      if (method !== 'Fetch.requestPaused') return;
      const task = (async () => {
        let body;
        try {
          body = JSON.parse(params.request.postData || '{}');
        } catch {
          body = {};
        }
        if (body.action !== action || body.lessonId !== lessonId) {
          await window.webContents.debugger.sendCommand('Fetch.continueRequest', {
            requestId: params.requestId,
          });
          return;
        }
        const responseBody = await window.webContents.debugger.sendCommand(
          'Fetch.getResponseBody',
          { requestId: params.requestId },
        );
        const payload = JSON.parse(
          responseBody.base64Encoded
            ? Buffer.from(responseBody.body, 'base64').toString('utf8')
            : responseBody.body,
        );
        const dropped = loseFirstSuccess && exchanges.length === 0 && payload.ok;
        exchanges.push({ body, payload, dropped });
        await window.webContents.debugger.sendCommand(
          dropped ? 'Fetch.failRequest' : 'Fetch.continueRequest',
          {
            requestId: params.requestId,
            ...(dropped ? { errorReason: 'ConnectionClosed' } : {}),
          },
        );
      })().catch(() => {
        protocolError = new Error('计划HTTP截获失败');
      });
      tasks.add(task);
      task.finally(() => tasks.delete(task));
    };
    window.webContents.debugger.on('message', onPaused);
    await window.webContents.debugger.sendCommand('Fetch.enable', {
      patterns: [{ urlPattern: '*/api/study/lessons', requestStage: 'Response' }],
    });
    try {
      await operation(exchanges, () => {
        if (protocolError) throw protocolError;
      });
      if (protocolError) throw protocolError;
      return exchanges;
    } finally {
      await window.webContents.debugger.sendCommand('Fetch.disable');
      window.webContents.debugger.removeListener('message', onPaused);
      await Promise.allSettled([...tasks]);
    }
  };

  markStep('lesson-plan:edit-review-publication');
  await window.loadURL(`${origin}/workbench/lessons`);
  await waitForText('场景计划真实交互回归课', '场景计划课程未加载');
  await waitFor(
    `Object.keys((${rowExpression})?.querySelector('[data-scene-plan-save]') || {}).some(key => key.startsWith('__reactProps$'))`,
    '计划编辑器未完成客户端挂接',
  );
  await markRow();
  await execute(
    `document.querySelector(${JSON.stringify(rowSelector + ' [data-scene-plan-save]')}).closest('details').querySelector('summary').setAttribute('data-plan-smoke-summary','current')`,
  );
  await click('[data-plan-smoke-summary="current"]', 'plan:open-editor');
  const titleSelector = `${rowSelector} [data-scene-title]`;
  await typeText(titleSelector, '');
  const invalidExchanges = await capture('save-scene-plan', false, async () => {
    await click(`${rowSelector} [data-scene-plan-save]`, 'plan:invalid-title');
    await waitFor(
      `document.querySelector(${JSON.stringify(rowSelector)})?.textContent.includes('计划内容无效')`,
      '无效标题未显示本地校验',
    );
  });
  assert(
    invalidExchanges.length === 0 &&
      (await execute(
        `!document.querySelector(${JSON.stringify(titleSelector)})?.disabled && !document.querySelector(${JSON.stringify(rowSelector + ' [data-scene-plan-retry]')})`,
      )),
    '无效内容发送请求或锁死编辑器',
  );
  assert(!(await readPlan()), '本地无效标题校验写入了计划');
  await typeText(titleSelector, '陈述 1');
  cover(
    'scene plan local validation: empty title sends no HTTP request and stays editable for correction',
  );
  await click(`${rowSelector} [data-scene-regenerate]`, 'plan:create-element');
  const bodySelector = `${rowSelector} [data-element-text]`;
  const text1 = '计划正文第一稿：同一区间内任取两点，比较函数值。';
  await typeText(bodySelector, text1);
  const first = await save(1, text1);
  await clickText('审核通过');
  await waitFor(
    `(${rowExpression})?.children[3]?.textContent.includes('已通过')`,
    '第一稿人工审核未刷新',
  );
  const firstReview = (await catalog()).reviews.find(
    (review) => review.lessonId === lessonId && review.version === version,
  );
  assert(
    firstReview?.planRevision === 1 && firstReview.planDigest === first.digest,
    '人工审核未绑定实际保存的计划内容',
  );

  const text2 = '审核后的第二稿：明确保留同一区间和任意取值两个条件。';
  await typeText(bodySelector, text2);
  await save(2, text2);
  const blocked = await capture('publish', false, async (exchanges, check) => {
    await clickText(`发布 v${version}`);
    await poll(() => {
      check();
      return exchanges.length === 1;
    }, '旧审核发布请求没有真实返回');
    await waitFor(
      `document.body.textContent.includes('VERSION_CONFLICT')`,
      '旧计划审核发布没有显示错误',
    );
  });
  assert(
    !blocked[0].payload.ok && blocked[0].payload.error.code === 'VERSION_CONFLICT',
    '编辑后旧审核仍能发布',
  );
  assert(
    (await catalog()).versions.find(
      (lesson) => lesson.lessonId === lessonId && lesson.version === version,
    )?.status === 'draft',
    '受阻发布仍改变了课程状态',
  );
  cover(
    'scene plan review: trusted mouse/keyboard edit and save bind review to revision/digest; changed content blocks actual publication',
  );

  markStep('lesson-plan:refresh-conflict');
  const localText = '本地未保存正文：刷新后必须保留，不能静默覆盖远端。';
  await typeText(bodySelector, localText);
  const remoteText = '另一合法请求的第三稿：远端已推进，普通保存必须受阻。';
  const second = await readPlan();
  const remoteScenes = structuredClone(second.scenes);
  remoteScenes[0].elements[0].text = remoteText;
  await serviceRequest('POST', '/api/study/lessons', {
    scope,
    action: 'save-scene-plan',
    requestId: `native-plan-remote-${lessonId}`,
    lessonId,
    version,
    baseRevision: second.revision,
    scenes: remoteScenes,
  });
  // Review performs a real router.refresh without remounting this keyed editor.
  // A full window.loadURL would erase local state and miss the stale-props bug.
  await clickText('审核通过');
  await waitFor(
    `Boolean((${rowExpression})?.querySelector('[data-scene-plan-load-latest]'))`,
    '远端推进后刷新未显示计划冲突',
  );
  await markRow();
  assert(
    await execute(`document.querySelector(${JSON.stringify(bodySelector)})?.value === ${JSON.stringify(localText)}
    && document.querySelector(${JSON.stringify(rowSelector + ' [data-scene-plan-save]')})?.disabled
    && document.querySelector(${JSON.stringify(rowSelector)})?.textContent.includes('服务端计划已推进到修订 3')`),
    '刷新冲突丢失未保存编辑或允许普通保存',
  );
  await assertPlan(3, remoteText);
  await click(`${rowSelector} [data-scene-plan-load-latest]`, 'plan:load-latest');
  await waitFor(
    `document.querySelector(${JSON.stringify(bodySelector)})?.value === ${JSON.stringify(remoteText)}
    && !document.querySelector(${JSON.stringify(rowSelector + ' [data-scene-plan-save]')})?.disabled`,
    '显式载入最新计划没有更新正文与保存基线',
  );
  cover(
    'scene plan refresh conflict: uncommitted local text survives router refresh; remote revision disables normal save until explicit reload',
  );

  markStep('lesson-plan:committed-response-loss');
  const finalText = '最终冻结正文：同一区间内任取 x1 < x2，逐点比较 f(x1) 与 f(x2)。';
  await typeText(bodySelector, finalText);
  const savedExchanges = await capture('save-scene-plan', true, async (exchanges, check) => {
    await click(`${rowSelector} [data-scene-plan-save]`, 'plan:drop-save-response');
    await poll(() => {
      check();
      return exchanges.length === 1;
    }, '响应丢失夹具没有截获已提交请求');
    assert(
      exchanges[0].dropped && exchanges[0].payload.data?.receipt?.state === 'completed',
      '夹具没有在真实业务提交成功后丢响应',
    );
    await assertPlan(4, finalText);
    await waitFor(
      `Boolean(document.querySelector(${JSON.stringify(rowSelector + ' [data-scene-plan-retry]')}))
      && !document.querySelector(${JSON.stringify(rowSelector + ' [data-scene-plan-retry]')}).disabled`,
      '丢失响应后没有明确的原请求重试入口',
    );
    await click(`${rowSelector} [data-scene-plan-retry]`, 'plan:retry-original-request');
    await poll(() => {
      check();
      return exchanges.length === 2;
    }, '原请求重试没有真实返回');
    await waitFor(
      `(${rowExpression})?.querySelector('[data-scene-plan-save]')?.closest('details').querySelector('summary')?.textContent.includes('修订 4')`,
      '重试成功未读回权威计划revision',
    );
  });
  const [committed, retried] = savedExchanges;
  assert(
    JSON.stringify(committed.body) === JSON.stringify(retried.body) &&
      committed.body.requestId === retried.body.requestId,
    '丢失响应重试改变了nonce或原请求快照',
  );
  assert(
    retried.payload.ok &&
      retried.payload.data.deduplicated === true &&
      retried.payload.data.receipt.requestId === committed.body.requestId &&
      JSON.stringify(retried.payload.data.receipt) ===
        JSON.stringify(committed.payload.data.receipt) &&
      JSON.stringify(retried.payload.data.plan) === JSON.stringify(committed.payload.data.plan),
    '原请求重试没有读回同一已提交回执与计划',
  );
  const finalPlan = await assertPlan(4, finalText);
  assert(savedExchanges.length === 2, '响应丢失场景发生了额外计划写入请求');
  cover(
    'scene plan response loss: CDP drops real committed response; explicit native retry preserves complete intent/nonce and replays same receipt, digest and revision exactly once',
  );

  markStep('lesson-plan:rereview-classroom');
  await clickText('审核通过');
  let reviewed;
  await poll(async () => {
    reviewed = (await catalog()).reviews.find(
      (review) => review.lessonId === lessonId && review.version === version,
    );
    return reviewed?.planRevision === 4;
  }, '重新审核未绑定最终计划revision');
  await waitFor(
    `!(${rowExpression})?.querySelector('[data-scene-plan-save]')?.disabled`,
    '重新审核未结束',
  );
  assert(
    reviewed?.planRevision === 4 && reviewed.planDigest === finalPlan.digest,
    '重新审核未绑定最终正文',
  );
  await clickText(`发布 v${version}`);
  await waitFor(
    `(${rowExpression})?.children[2]?.textContent.includes('已发布')`,
    '重新审核后的计划未发布',
  );
  await clickText('生成课件文档并挂接');
  await waitFor(
    `Boolean((${rowExpression})?.querySelector('a[href=${JSON.stringify('/classroom/' + lessonId)}]'))`,
    '发布计划没有生成真实课堂文档',
  );
  await markRow();
  await click(`${rowSelector} a[href="/classroom/${lessonId}"]`, 'plan:enter-classroom');
  await waitForText('场景计划真实交互回归课', '冻结计划课堂未加载');
  await click(
    `button.tab[data-scene-id="${finalPlan.scenes[0].sceneId}"]`,
    'plan:select-frozen-slide',
  );
  const elementId = finalPlan.scenes[0].elements[0].elementId;
  await waitFor(
    `document.getElementById(${JSON.stringify('slide-element-' + elementId)})?.textContent === ${JSON.stringify(finalText)}`,
    '课堂画布没有读到审核/保存的确切正文',
  );
  await assertPlan(4, finalText);
  cover(
    'scene plan classroom: renewed review binds final digest; native publish/attach/enter paints exact authoritative element text with unchanged plan revision',
  );
};
