/* Formal quiz regression in the actual sandboxed Electron renderer. The caller
 * owns the temporary project/service lifecycle; no provider requests are made. */
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

module.exports = async ({
  window,
  origin,
  projectDirectory,
  serviceRequest,
  waitForText,
  cover,
  markStep = () => {},
  planOnly = false,
}) => {
  const state = await serviceRequest('GET', '/api/study/state');
  const scope = { projectId: state.project.projectId, generation: state.project.generation };
  const imported = await serviceRequest('POST', '/api/study/materials', {
    scope,
    mode: 'text',
    displayName: '正式测验回归材料.md',
    type: 'md',
    rawText:
      '增函数在同一区间内满足 x1 < x2 时 f(x1) < f(x2)。定义中的区间和任意取值都是必要条件。',
  });
  const knowledgeIds = [];
  for (const label of ['单选回归', '多选回归', '简答回归']) {
    const proposed = await serviceRequest('POST', '/api/study/knowledge/propose', {
      scope,
      name: label,
      concept: '同一区间内任取 x1 < x2 有 f(x1) < f(x2)',
      scopeStatus: 'in_syllabus',
      proposedBy: 'user',
      evidence: [
        {
          materialId: imported.material.materialId,
          revision: 1,
          segmentId: imported.segments[0].segmentId,
          use: 'concept_basis',
        },
      ],
    });
    const reviewed = await serviceRequest('POST', '/api/study/knowledge/review', {
      scope,
      proposalId: proposed.proposal.proposalId,
      expectedRevision: proposed.proposal.revision,
      decision: 'approved',
      semanticReviewed: true,
      note: '回归夹具审核，不代表真实科目验收',
    });
    knowledgeIds.push(reviewed.knowledgePoint.knowledgeId);
  }
  await serviceRequest('POST', '/api/study/plan', { scope, action: 'generate' });
  for (const knowledgeId of knowledgeIds) {
    await serviceRequest('POST', '/api/study/plan', {
      scope,
      action: 'confirm-task',
      knowledgeId,
      decision: 'accept',
    });
  }
  await serviceRequest('POST', '/api/study/plan', { scope, action: 'confirm' });

  const types = ['single', 'multiple', 'short_answer'];
  const questionIds = [];
  for (const [index, type] of types.entries()) {
    const options =
      type === 'short_answer'
        ? []
        : [
            { value: 'A', label: '同一区间内任意两点' },
            { value: 'B', label: '函数值保持相应次序' },
            { value: 'C', label: '只比较一个点' },
          ];
    const correctAnswers = type === 'single' ? ['B'] : type === 'multiple' ? ['A', 'B'] : [];
    const created = await serviceRequest('POST', '/api/study/questions', {
      scope,
      stem: `正式测验 ${type}：说明增函数定义`,
      answer: '仅服务端保存的参考答案',
      solution: '仅服务端保存的解析',
      knowledgeIds: [knowledgeIds[index]],
      requestedOrigin: 'ai_new',
      originRecord: null,
      assessment: {
        schemaVersion: 1,
        type,
        options,
        correctAnswers,
        maxScore: 3,
        rubric: '说明同一区间和任意取值两个条件，简答需要人工核对。',
        answerVersion: 1,
      },
    });
    questionIds.push(created.question.questionId);
  }
  const bundle = await serviceRequest('POST', '/api/study/lessons', {
    scope,
    action: 'build-bundle',
    questionIds,
    statements: knowledgeIds.map((knowledgeId) => ({
      knowledgeId,
      text: '同一区间内任取 x1 < x2 有 f(x1) < f(x2)',
      conditions: '同一区间内',
    })),
  });
  const draft = await serviceRequest('POST', '/api/study/lessons', {
    scope,
    action: 'draft',
    lessonId: null,
    bundleId: bundle.bundleId,
    title: '正式测验三题型回归课',
    statementIds: bundle.bundle.statements.map((item) => item.statementId),
    questionIds,
  });
  const lessonId = draft.lesson.lessonId;
  const version = draft.lesson.version;
  await serviceRequest('POST', '/api/study/lessons', {
    scope,
    action: 'review',
    lessonId,
    version,
    decision: 'approved',
    note: '对冻结题型与答案集做夹具审核',
  });
  await serviceRequest('POST', '/api/study/lessons', {
    scope,
    action: 'publish',
    lessonId,
    version,
  });
  const assembled = await serviceRequest('POST', '/api/study/lessons', {
    scope,
    action: 'attach-document',
    lessonId,
    version,
  });
  const quizzes = assembled.document.scenes.filter((scene) => scene.sceneType === 'quiz');
  assert(quizzes.length === 3, '正式课程未生成三种题型的真实测验场景');

  let activePhase = 'setup';
  const setPhase = (phase) => {
    activePhase = phase;
    markStep(`formal-quiz:${phase}`);
  };
  const exceptionType = (error) => {
    const name = error instanceof Error ? error.name : '';
    return [
      'Error',
      'TypeError',
      'ReferenceError',
      'SyntaxError',
      'RangeError',
      'AbortError',
    ].includes(name)
      ? name
      : 'Other';
  };
  const failPhase = (phase, error) => {
    const type = exceptionType(error);
    markStep(`formal-quiz:${phase}:failed:${type}`);
    throw new Error(`formal quiz phase failed (${phase}; type=${type})`);
  };
  const execute = async (script, phase = activePhase) => {
    try {
      return await window.webContents.executeJavaScript(script);
    } catch (error) {
      failPhase(`${phase}:renderer-execute`, error);
    }
  };
  if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
  const mouse = (type, { x, y }, button) =>
    window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      ...(button === 'left' ? { clickCount: 1 } : {}),
    });
  const waitFor = async (script, message, phase = 'wait') => {
    setPhase(phase);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await execute(script)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    markStep(`formal-quiz:${phase}:timeout`);
    throw new Error(message);
  };
  let clickOrdinal = 0;
  const click = async (selector, phase = `click-${++clickOrdinal}`) => {
    const encoded = JSON.stringify(selector);
    await waitFor(
      `Boolean(document.querySelector(${encoded})) && !document.querySelector(${encoded}).disabled`,
      `课堂控件尚未就绪：${selector}`,
      `${phase}:enabled`,
    );
    setPhase(`${phase}:scroll`);
    await execute(
      `document.querySelector(${encoded})?.scrollIntoView({block:'center', behavior:'instant'})`,
    );
    setPhase(`${phase}:paint`);
    await execute(
      `new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)))`,
    );
    setPhase(`${phase}:position`);
    const position = await execute(
      `(() => {
      try {
        const node = document.querySelector(${encoded});
        if (!node) return {ok:false,reason:'target-missing'};
        if (node.disabled) return {ok:false,reason:'target-disabled'};
        const box = node.getBoundingClientRect();
        const x = Math.round(box.left + box.width / 2);
        const y = Math.round(box.top + box.height / 2);
        const hit = document.elementFromPoint(x,y);
        if (hit !== node && !node.contains(hit)) return {
          ok:false,
          reason:'hit-obstructed',
          hitTag:['A','BUTTON','INPUT','LABEL','SPAN','DIV','HTML','BODY','MAIN','SECTION','FIELDSET','TD','TH','TABLE','SUMMARY'].includes(hit?.tagName) ? hit.tagName : hit ? 'OTHER' : 'NONE',
          associatedLabel:hit instanceof HTMLLabelElement && hit.control === node,
          box:{x:box.x,y:box.y,width:box.width,height:box.height},
          viewport:{width:innerWidth,height:innerHeight}
        };
        return {ok:true,x,y};
      } catch (error) {
        const name = error instanceof TypeError ? 'TypeError' : error instanceof ReferenceError ? 'ReferenceError' : 'Error';
        return {ok:false,reason:'renderer-exception',exceptionType:name};
      }
    })()`,
      `${phase}:position`,
    );
    if (!position?.ok) {
      const reason = [
        'hit-obstructed',
        'target-missing',
        'target-disabled',
        'renderer-exception',
      ].includes(position?.reason)
        ? position.reason
        : 'invalid-position';
      const hitTag = [
        'A',
        'BUTTON',
        'INPUT',
        'LABEL',
        'SPAN',
        'DIV',
        'HTML',
        'BODY',
        'MAIN',
        'SECTION',
        'FIELDSET',
        'TD',
        'TH',
        'TABLE',
        'SUMMARY',
        'OTHER',
        'NONE',
      ].includes(position?.hitTag)
        ? position.hitTag
        : 'UNKNOWN';
      const associatedLabel = position?.associatedLabel === true;
      const type =
        reason === 'renderer-exception' &&
        ['TypeError', 'ReferenceError', 'Error'].includes(position?.exceptionType)
          ? position.exceptionType
          : 'None';
      markStep(`formal-quiz:${phase}:position-failed:${reason}:${type}`);
      throw new Error(
        `formal quiz click failed (${phase}; reason=${reason}; hitTag=${hitTag}; associatedLabel=${associatedLabel}; type=${type}; box=${JSON.stringify(position?.box)}; viewport=${JSON.stringify(position?.viewport)})`,
      );
    }
    assert(position.x >= 0 && position.y >= 0, `课堂控件不可操作：${selector}`);
    setPhase(`${phase}:dispatch`);
    try {
      await mouse('mouseMoved', position, 'none');
      await mouse('mousePressed', position, 'left');
      await mouse('mouseReleased', position, 'left');
    } catch (error) {
      failPhase(`${phase}:dispatch`, error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  };
  const input = async (selector, value, phase = 'input') => {
    setPhase(phase);
    return execute(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('找不到输入框');
    const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  };

  if (planOnly) {
    await require('./smoke-lesson-plan.cjs')({
      window,
      origin,
      serviceRequest,
      waitForText,
      cover,
      markStep,
      execute,
      waitFor,
      click,
      bundleId: bundle.bundleId,
      bundle: bundle.bundle,
    });
    window.webContents.debugger.detach();
    await window.loadURL(`${origin}/workbench`);
    await waitForText('关闭项目', '场景计划回归后未返回工作台');
    return;
  }

  await window.loadURL(`${origin}/workbench/lessons`);
  await waitForText('登记题目与评分规则', '课程页未提供题目录入入口');
  // SSR text can be visible before the client handlers have hydrated.
  await waitFor(
    `Object.keys(document.querySelector('#qa-stem') || {}).some(key => key.startsWith('__reactProps$'))`,
    '题目录入表单未完成客户端挂接',
  );
  await input('#qa-stem', '通过真实表单登记的单选回归题');
  await input('#qa-option-A', '不满足定义');
  await input('#qa-option-B', '满足增函数定义');
  await click('#qa-correct-B');
  await click(`[data-question-authoring] [data-knowledge-id="${knowledgeIds[0]}"]`);
  await click('[data-question-authoring] button[type="submit"]');
  try {
    await waitForText('新编题与评分规则已保存', '题目录入表单未保存成功');
  } catch (caught) {
    const diagnosis = await execute(`(() => {
      const section = document.querySelector('[data-question-authoring]');
      return {text: section?.innerText, values: [...(section?.querySelectorAll('input,textarea') || [])]
        .map(node => ({id:node.id,value:node.value,checked:node.checked,valid:node.checkValidity()}))};
    })()`);
    throw new Error(`${caught.message}: ${JSON.stringify(diagnosis)}`);
  }
  const authored = await serviceRequest('GET', '/api/study/questions');
  const authoredQuestion = authored.questions.find(
    (question) => question.stem === '通过真实表单登记的单选回归题',
  );
  assert(authoredQuestion?.assessment?.type === 'single', '表单新题没有保存题型');
  assert(
    !Object.prototype.hasOwnProperty.call(authoredQuestion.assessment, 'correctAnswers') &&
      !Object.prototype.hasOwnProperty.call(authoredQuestion, 'answer'),
    '题目列表泄漏评分答案',
  );
  cover(
    'formal quiz authoring: real form saved rules, public list retains type/options and hides answers',
  );

  await window.loadURL(`${origin}/classroom/${encodeURIComponent(lessonId)}`);
  await waitForText('正式测验三题型回归课', '正式课堂未加载');
  const firstScene = quizzes.find((item) => item.questionId === questionIds[0]);
  await click(`button.tab[data-scene-id="${firstScene.sceneId}"]`);
  await waitFor(
    `Boolean(document.querySelector('[data-scene="quiz"] [data-attempt-submit]'))`,
    '第一题未准备好',
  );
  await click('[data-scene="quiz"] [data-answer-option="B"]');
  await input('[data-scene="quiz"] textarea[id^="process-"]', '先保存第一题草稿，再切换另一题。');
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));

  // Leave quiz A unfinished and submit quiz B first. Their active sessions must
  // stay independent, including a null tail on newly opened quiz B.
  for (const index of [1, 0, 2]) {
    const questionId = questionIds[index];
    const scene = quizzes.find((item) => item.questionId === questionId);
    assert(scene, '正式测验来源绑定丢失');
    await click(`button.tab[data-scene-id="${scene.sceneId}"]`);
    await waitFor(
      `Boolean(document.querySelector('[data-scene="quiz"] [data-attempt-submit]'))`,
      '测验组件未准备好',
    );
    if (types[index] === 'single') {
      const restoredDraft =
        await execute(`({checked:document.querySelector('[data-answer-option="B"]')?.checked,
        process:document.querySelector('textarea[id^="process-"]')?.value})`);
      assert(
        restoredDraft.checked && restoredDraft.process?.includes('先保存第一题草稿'),
        '跨题切换丢失第一题草稿',
      );
      cover(
        'formal quiz switching: unfinished A and submitted B keep separate runtime sessions and restore A draft',
      );
    }
    if (types[index] === 'multiple') {
      await click('[data-scene="quiz"] [data-answer-option="A"]');
      await click('[data-scene="quiz"] [data-answer-option="B"]');
    }
    if (types[index] === 'short_answer') {
      await input('[data-short-answer]', '同一区间内任意两点，函数值保持相应次序。');
    }
    await input('[data-scene="quiz"] textarea[id^="process-"]', '对照材料定义，保留本人解题过程。');
    await waitFor(
      `!document.querySelector('[data-attempt-submit]')?.disabled`,
      '作答界面未接受输入',
    );
    if (types[index] === 'multiple') {
      // Hold the real outgoing submit request, switch away while it is in
      // flight, then let the original server transaction finish unchanged.
      let pausedRequestId = null;
      const onPaused = (_event, method, params) => {
        if (method === 'Fetch.requestPaused') pausedRequestId = params.requestId;
      };
      window.webContents.debugger.on('message', onPaused);
      await window.webContents.debugger.sendCommand('Fetch.enable', {
        patterns: [{ urlPattern: '*/api/maic/runtime/submit', requestStage: 'Request' }],
      });
      try {
        await click('[data-attempt-submit]');
        const deadline = Date.now() + 20000;
        while (!pausedRequestId && Date.now() < deadline)
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        assert(pausedRequestId, '未拦到真实测验提交请求，无法验证在途切题');
        assert(
          await execute(`document.querySelector('[data-attempt-submit]')?.disabled === true`),
          '在途提交没有锁定原题',
        );
        await click(`button.tab[data-scene-id="${firstScene.sceneId}"]`);
        await waitFor(
          `document.querySelector('[data-attempt-submit]')?.disabled === false`,
          '提交途中切题导致新题一直忙碌',
        );
        assert(
          await execute(`document.querySelector('[data-answer-option="B"]')?.checked === true`),
          '在途切题丢失另一题草稿',
        );
        await window.webContents.debugger.sendCommand('Fetch.continueRequest', {
          requestId: pausedRequestId,
        });
        pausedRequestId = null;
      } finally {
        if (pausedRequestId)
          await window.webContents.debugger.sendCommand('Fetch.continueRequest', {
            requestId: pausedRequestId,
          });
        await window.webContents.debugger.sendCommand('Fetch.disable');
        window.webContents.debugger.removeListener('message', onPaused);
      }
      const deadline = Date.now() + 20000;
      let persisted = false;
      while (!persisted && Date.now() < deadline) {
        const saved = await serviceRequest('GET', '/api/study/attempts?kind=real');
        persisted = saved.attempts.some((attempt) => attempt.questionId === questionId);
        if (!persisted) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      assert(persisted, '切题后原请求没有保存测验结果');
      await click(`button.tab[data-scene-id="${scene.sceneId}"]`);
      cover(
        'formal quiz switching: in-flight B submit does not lock A, and original B result persists',
      );
    } else {
      await click('[data-attempt-submit]');
    }
    await waitFor(
      `Boolean(document.querySelector('[data-attempt-result]')) && !document.querySelector('[data-attempt-submit]')`,
      '测验提交未获得服务结果',
    );
    const feedback = await execute(`document.querySelector('[data-attempt-result]').textContent`);
    if (types[index] === 'short_answer')
      assert(feedback.includes('待判分'), '简答题未保持明确的待判分状态');
    cover(
      `formal ${types[index]}: browser mouse submission, saved process, ${types[index] === 'short_answer' ? 'pending grading' : 'server grading'}`,
    );
  }
  const attempts = await serviceRequest('GET', '/api/study/attempts?kind=real');
  const actual = questionIds.map((id) =>
    attempts.attempts.find((attempt) => attempt.questionId === id),
  );
  assert(actual.every(Boolean), '正式测验提交未全部落库');
  assert(
    actual[0].grading.status === 'correct' && actual[1].grading.status === 'correct',
    '客观题未按冻结答案集判分',
  );
  assert(
    actual[2].grading.status === 'pending_review' && actual[2].masteryAfter === null,
    '简答题错误更新了掌握',
  );
  assert(
    actual.every((attempt) => attempt.questionRevision === 1 && attempt.answerVersion === 1),
    '提交未冻结题目和答案版本',
  );

  const shortAttemptId = actual[2].attemptId;
  const gradingQuery = () =>
    new URLSearchParams({
      attemptId: shortAttemptId,
      projectId: scope.projectId,
      generation: String(scope.generation),
    });
  await window.loadURL(`${origin}/workbench/mistakes`);
  await waitForText('核对简答评分', '错题本没有已提交简答题评分入口');
  const panel = `[data-attempt-grading="${shortAttemptId}"]`;
  for (const [reviewIndex, earned] of [2, 3].entries()) {
    await waitFor(
      `Boolean(document.querySelector(${JSON.stringify(panel)}))`,
      '评分面板尚未准备好',
    );
    if (!(await execute(`document.querySelector(${JSON.stringify(panel)}).open`)))
      await click(`${panel} > summary`);
    await input(`${panel} [data-grade-score]`, String(earned));
    await input(
      `${panel} [data-grade-basis]`,
      reviewIndex === 0
        ? '已核对两个条件，解释还需补充，给部分分。'
        : '重新核对原答与过程，两个条件均已说明，给满分。',
    );
    await input(`${panel} [data-grade-uncertainty]`, '本次仅核对本题，不推断其他知识点的表现。');
    await click(`${panel} [data-grade-semantic]`);
    await click(`${panel} [data-grade-submit]`);
    await waitFor(
      `document.querySelector(${JSON.stringify(panel)})?.textContent.includes('审核 v${reviewIndex + 1}')`,
      '人工评分没有更新界面版本',
    );
    const graded = await serviceRequest('GET', `/api/study/grading?${gradingQuery()}`);
    assert(
      graded.currentReviewVersion === reviewIndex + 1 && graded.effectiveGrading.earned === earned,
      '人工评分没有保存追加版本',
    );
    assert(
      graded.submissionGrading.status === 'pending_review' &&
        graded.answerText === actual[2].answerText &&
        graded.processText === actual[2].processText,
      '人工评分改写了原始提交',
    );
    assert(graded.reviews.length === reviewIndex + 1, '人工评分重复或丢失了历史');
  }
  const originalAfterReview = await serviceRequest('GET', '/api/study/attempts?kind=real');
  assert(
    originalAfterReview.attempts.find((attempt) => attempt.attemptId === shortAttemptId)?.grading
      .status === 'pending_review',
    '有效评分错误覆盖原始提交收据',
  );
  cover(
    'formal short answer grading: real human review form appends partial/full score versions and preserves original answer/process/receipt',
  );

  const connection = await serviceRequest('GET', '/api/study/models');
  assert(!connection.configured, 'AI候选界面回归要求隔离且未配置模型的profile');
  const feedbackPanel = `[data-feedback-attempt="${shortAttemptId}"]`;
  const feedbackQuery = `/api/study/feedback?${gradingQuery()}`;
  const feedbackBefore = await serviceRequest('GET', feedbackQuery);
  for (const selector of ['[data-feedback-ai-error]', '[data-feedback-ai-review]']) {
    await waitFor(
      `Boolean(document.querySelector(${JSON.stringify(feedbackPanel + ' ' + selector)})) && !document.querySelector(${JSON.stringify(feedbackPanel + ' ' + selector)}).disabled`,
      'AI候选按钮没有就绪',
    );
    await click(`${feedbackPanel} ${selector}`);
    await waitFor(
      `Boolean(document.querySelector(${JSON.stringify(feedbackPanel + ' [role="alert"]')})) && !document.querySelector(${JSON.stringify(feedbackPanel + ' ' + selector)}).disabled`,
      '未配置模型时没有显示明确失败或按钮未释放',
    );
  }
  const feedbackAfter = await serviceRequest('GET', feedbackQuery);
  assert(
    JSON.stringify(feedbackBefore) === JSON.stringify(feedbackAfter),
    '未配置模型的候选请求改变了本人反馈记录',
  );
  cover(
    'AI feedback: native error/review request controls reject unconfigured calls and preserve personal facts',
  );

  // Close and reopen the SQLite project via its trusted control entry. The app
  // stays running; this verifies database reopen, not an entire app restart.
  await serviceRequest('POST', '/internal/project', { action: 'close' });
  const reopened = await serviceRequest('POST', '/internal/project', {
    action: 'open',
    path: projectDirectory,
  });
  assert(reopened.session, '项目未重新打开');
  await window.loadURL(`${origin}/classroom/${encodeURIComponent(lessonId)}`);
  await waitForText('正式测验三题型回归课', '重开项目后正式课堂未加载');
  const shortScene = quizzes.find((item) => item.questionId === questionIds[2]);
  await click(`button.tab[data-scene-id="${shortScene.sceneId}"]`);
  await waitFor(
    `document.querySelector('[data-attempt-result]')?.textContent.includes('人工评分 v2')`,
    '重开课堂后未读回最新人工评分',
  );
  const gradedAgain = await serviceRequest(
    'GET',
    `/api/study/grading?${new URLSearchParams({
      attemptId: shortAttemptId,
      projectId: reopened.session.projectId,
      generation: String(reopened.session.generation),
    })}`,
  );
  assert(
    gradedAgain.currentReviewVersion === 2 &&
      gradedAgain.reviews.length === 2 &&
      gradedAgain.effectiveGrading.earned === 3,
    '项目重开后丢失评分历史或重复审核',
  );
  const restored = await execute(`({answer: document.querySelector('[data-short-answer]')?.value,
    process: document.querySelector('textarea[id^="process-"]')?.value})`);
  assert(
    restored.answer?.includes('任意两点') && restored.process?.includes('保留本人解题过程'),
    '重新打开后丢失本人答案或过程',
  );
  const after = await serviceRequest('GET', '/api/study/attempts?kind=real');
  assert(
    after.attempts.filter((attempt) => questionIds.includes(attempt.questionId)).length === 3,
    '读回测验重复计数',
  );
  cover(
    'formal quiz: project database reopen restores immutable answers/process and latest human grading without duplicate attempts or reviews',
  );
  await require('./smoke-classroom-stage.cjs')({
    window,
    origin,
    projectDirectory,
    serviceRequest,
    waitForText,
    cover,
    execute,
    waitFor,
    click,
    input,
    lessonId,
    lessonVersion: version,
    quizScenes: quizzes,
    bundleId: bundle.bundleId,
    bundle: bundle.bundle,
  });
  window.webContents.debugger.detach();
  await window.loadURL(`${origin}/workbench`);
  await waitForText('关闭项目', '正式测验回归后未返回工作台');
};
