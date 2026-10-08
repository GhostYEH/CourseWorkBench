/* Real hydrated PBL controls against a disposable authenticated HTTP/SQLite project.
 * Provider credentials are absent. This proves local runtime behavior, not live AI quality. */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

module.exports = async ({
  window,
  origin,
  serviceRequest,
  waitForText,
  cover,
  markStep,
  execute,
  waitFor,
  click,
  bundleId,
  bundle,
}) => {
  const project = (await serviceRequest('GET', '/api/study/state')).project;
  const scope = { projectId: project.projectId, generation: project.generation };
  const scopedHeaders = {
    'x-sew-project-id': scope.projectId,
    'x-sew-generation': String(scope.generation),
  };
  const drafted = await serviceRequest('POST', '/api/study/lessons', {
    scope,
    action: 'draft',
    lessonId: null,
    bundleId,
    title: 'PBL真实界面验收课',
    statementIds: [bundle.statements[0].statementId],
    questionIds: [],
  });
  const lesson = drafted.lesson;
  const rowExpression = `[...document.querySelectorAll('tbody > tr')].find(row => row.firstElementChild?.textContent.trim() === ${JSON.stringify(lesson.lessonId)})`;
  const typeText = async (selector, text) => {
    await click(selector, 'pbl:edit');
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
      'PBL实际输入未触发',
    );
  };
  markStep('pbl:author-definition');
  await window.loadURL(`${origin}/workbench/lessons`);
  await waitForText(lesson.title, 'PBL课程未显示');
  await waitFor(
    `Boolean((${rowExpression})?.querySelector('[data-pbl-author]'))`,
    'PBL作者入口未挂接',
  );
  await execute(
    `(${rowExpression}).setAttribute('data-pbl-smoke-row','current'); document.querySelector('[data-pbl-smoke-row] [data-pbl-author] summary').setAttribute('data-pbl-smoke-author-summary','current')`,
  );
  await click('[data-pbl-smoke-author-summary]', 'pbl:open-author');
  const author = '[data-pbl-smoke-row] [data-pbl-author]';
  await waitFor(
    `Object.keys(document.querySelector(${JSON.stringify(author + ' [data-pbl-definition]')}) || {}).some(key => key.startsWith('__reactProps$'))`,
    'PBL作者输入未完成hydration',
  );
  assert(
    await execute(
      `document.querySelector(${JSON.stringify(author + ' [data-pbl-freeze]')}).disabled`,
    ),
    '未语义审核就可冻结',
  );
  const definition = await execute(
    `JSON.parse(document.querySelector(${JSON.stringify(author + ' [data-pbl-definition]')}).value)`,
  );
  definition.title = '校园函数项目验收';
  definition.authenticContext = {
    audience: '校园数学社团',
    problem: '依据冻结来源解释一组函数数据',
    constraints: ['仅用已审核的来源陈述'],
  };
  definition.background = '本验收使用临时来源资料，检验项目任务、交付及演练的实际运行。';
  await typeText(author + ' [data-pbl-definition]', JSON.stringify(definition, null, 2));
  await typeText(
    author + ' [data-pbl-review-note]',
    '核对项目背景、陈述和每一项确定性检查；仅为软件夹具。',
  );
  await click(author + ' [data-pbl-semantic-review]', 'pbl:semantic-review');
  await click(author + ' [data-pbl-freeze]', 'pbl:freeze');
  await waitFor(
    `document.querySelector(${JSON.stringify(author)})?.textContent.includes('已冻结')`,
    'PBL冻结未读回',
  );
  const frozen = await serviceRequest(
    'GET',
    `/api/study/pbl?lessonId=${encodeURIComponent(lesson.lessonId)}&lessonVersion=${lesson.version}`,
    undefined,
    scopedHeaders,
  );
  assert(frozen.frozen.definition.title === definition.title, '作者控件未写入已审核定义');
  assert(
    frozen.frozen.definition.roles.find((role) => role.kind === 'mentor').memberUid !== null,
    'AI角色未由server注册',
  );
  cover(
    'PBL author: real JSON input, explicit semantic review, immutable frozen readback and server-assigned AI identity',
  );

  await serviceRequest('POST', '/api/study/lessons', {
    scope,
    action: 'review',
    lessonId: lesson.lessonId,
    version: lesson.version,
    decision: 'approved',
    note: '冻结PBL课程软件验收',
  });
  await serviceRequest('POST', '/api/study/lessons', {
    scope,
    action: 'publish',
    lessonId: lesson.lessonId,
    version: lesson.version,
  });
  const assembled = await serviceRequest('POST', '/api/study/lessons', {
    scope,
    action: 'attach-document',
    lessonId: lesson.lessonId,
    version: lesson.version,
  });
  const pblScene = assembled.document.scenes.find((scene) => scene.sceneType === 'pbl');
  assert(pblScene, 'PBL没有进入实际正式课堂');
  const readState = () =>
    serviceRequest(
      'GET',
      `/api/study/pbl?stageId=${encodeURIComponent(assembled.document.stageId)}&definitionId=${encodeURIComponent(definition.id)}`,
      undefined,
      scopedHeaders,
    );
  const openClassroom = async () => {
    await window.loadURL(`${origin}/classroom/${lesson.lessonId}`);
    await waitFor(
      `Boolean(document.querySelector('button[data-scene-id=${JSON.stringify(pblScene.sceneId)}]'))`,
      'PBL课堂标签不存在',
    );
    await click(`button[data-scene-id="${pblScene.sceneId}"]`, 'pbl:scene');
    await waitFor(
      `Boolean(document.querySelector('[data-scene="pbl"] [data-pbl-save-draft]'))`,
      'PBL本人入口未就绪',
    );
    await waitFor(
      `Object.keys(document.querySelector('[data-pbl-artifact-text]') || {}).some(key => key.startsWith('__reactProps$'))`,
      'PBL课堂未hydration',
    );
  };
  const prefix = '[data-scene="pbl"]';
  const requests = [];
  const onRequest = (_event, method, params) => {
    if (method === 'Network.requestWillBeSent' && params.request.url.includes('/api/study/pbl'))
      requests.push({ method: params.request.method, url: new URL(params.request.url).pathname });
  };
  window.webContents.debugger.on('message', onRequest);
  await window.webContents.debugger.sendCommand('Network.enable');
  try {
    markStep('pbl:task-and-draft');
    await openClassroom();
    await typeText(prefix + ' [data-pbl-report]', '本人开始制作报告');
    await click(prefix + ' [data-pbl-task-command]', 'pbl:open-task');
    await waitFor(
      `document.querySelector(${JSON.stringify(prefix)})?.textContent.includes('in_progress')`,
      'PBL任务没有权威更新',
    );
    await typeText(prefix + ' [data-pbl-artifact-title]', '本人函数报告');
    await typeText(
      prefix + ' [data-pbl-artifact-text]',
      '同一区间内任取两点，按已审核定义比较函数值；这里是本人的正式报告正文。',
    );
    await click(prefix + ' [data-pbl-save-draft]', 'pbl:save-draft');
    await waitFor(`!document.querySelector('[data-pbl-save-draft]')?.disabled`, 'PBL保存未完成');
    const draft = await readState();
    assert(
      draft.ownDraft?.artifactTitle === '本人函数报告' && draft.count === 0,
      'PBL草稿未持久化或被计成交付',
    );
    await openClassroom();
    await waitFor(
      `document.querySelector('[data-pbl-artifact-title]')?.value === '本人函数报告'`,
      'PBL重新进入后草稿没恢复',
    );
    cover(
      'PBL task and draft: real controls open task, persist private draft and restore after navigation without formal submission',
    );

    markStep('pbl:lost-submit-response');
    const exchanges = [];
    const tasks = new Set();
    let interceptionError = null;
    const onPaused = (_event, method, params) => {
      if (method !== 'Fetch.requestPaused') return;
      const pending = (async () => {
        const body = JSON.parse(params.request.postData || '{}');
        if (body.operation !== 'submit') {
          await window.webContents.debugger.sendCommand('Fetch.continueRequest', {
            requestId: params.requestId,
          });
          return;
        }
        const response = await window.webContents.debugger.sendCommand('Fetch.getResponseBody', {
          requestId: params.requestId,
        });
        const payload = JSON.parse(
          response.base64Encoded
            ? Buffer.from(response.body, 'base64').toString('utf8')
            : response.body,
        );
        const dropped = exchanges.length === 0 && payload.ok;
        exchanges.push({ body, payload, dropped });
        await window.webContents.debugger.sendCommand(
          dropped ? 'Fetch.failRequest' : 'Fetch.continueRequest',
          { requestId: params.requestId, ...(dropped ? { errorReason: 'ConnectionClosed' } : {}) },
        );
      })().catch((error) => {
        interceptionError = error;
      });
      tasks.add(pending);
      pending.finally(() => tasks.delete(pending));
    };
    window.webContents.debugger.on('message', onPaused);
    await window.webContents.debugger.sendCommand('Fetch.enable', {
      patterns: [{ urlPattern: '*/api/study/pbl', requestStage: 'Response' }],
    });
    try {
      await click(prefix + ' [data-pbl-submit]', 'pbl:submit-first');
      await waitFor(
        `Boolean(document.querySelector('[data-scene="pbl"] [role="alert"]'))`,
        'PBL丢响应未报告',
      );
      await click(prefix + ' [data-pbl-submit]', 'pbl:retry-submit');
      await waitFor(
        `document.querySelector('[data-scene="pbl"]')?.textContent.includes('本人历史产物') && !document.querySelector('[data-pbl-submit]')?.disabled && !document.querySelector('[data-scene="pbl"] [role="alert"]')`,
        'PBL重试未成功',
      );
    } finally {
      await window.webContents.debugger.sendCommand('Fetch.disable');
      window.webContents.debugger.removeListener('message', onPaused);
      await Promise.allSettled([...tasks]);
    }
    if (interceptionError) throw interceptionError;
    assert(
      exchanges.length === 2 &&
        exchanges[0].dropped &&
        exchanges[0].body.nonce === exchanges[1].body.nonce &&
        exchanges[1].payload.data.deduplicated,
      'PBL丢响应重试未复用原nonce/收据',
    );
    const submitted = await readState();
    assert(
      submitted.count === 1 &&
        submitted.ownSubmissions.length === 1 &&
        submitted.tasks[0].status === 'verified',
      'PBL本人交付或检查结论不一致',
    );
    assert(!JSON.stringify(submitted.definition).includes('rubric'), '私有评分依据出现在课堂定义');
    cover(
      'PBL submit: real lost-response retry reuses original nonce and commits exactly one human deliverable; checks are server-derived',
    );

    markStep('pbl:demo-isolation');
    await execute(`document.querySelector('[data-pbl-demo-open]').closest('details').open = true`);
    await click('[data-pbl-demo-open]', 'pbl:demo-open');
    await waitFor(`Boolean(document.querySelector('[data-pbl-demo-add-open]'))`, 'PBL演练未开启');
    await click('[data-pbl-demo-add-open]', 'pbl:demo-add-open');
    await click('[data-pbl-demo-add-submit]', 'pbl:demo-add-submit');
    await click('[data-pbl-demo-run]', 'pbl:demo-run');
    await waitFor(
      `document.querySelector('[data-pbl-demo]')?.textContent.includes('演练任务') && document.querySelector('[data-pbl-demo]')?.textContent.includes('verified') && !document.querySelector('[data-pbl-demo-run]')?.disabled`,
      'PBL演练未运行权威判定',
    );
    assert((await readState()).count === 1, '演练写进了本人正式记录');
    cover(
      'PBL demo: actual learner open and submit execute the production checks without adding formal records',
    );
    const baselineGets = requests.filter((request) => request.method === 'GET').length;
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    assert(
      requests.filter((request) => request.method === 'GET').length - baselineGets < 3,
      'PBL状态渲染反复请求形成循环',
    );
    cover('PBL UI: settled state does not repeatedly reload or wipe the private draft');
  } finally {
    window.webContents.debugger.removeListener('message', onRequest);
  }
};
