/* Actual sandboxed profile UI regression. The caller owns a disposable profile/project. */
const { join } = require('node:path');
const { clipboard } = require('electron');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

module.exports = async ({
  window,
  origin,
  projectDirectory,
  serviceRequest,
  cover,
  markStep = () => {},
}) => {
  const evaluate = async (script, phase) => {
    try {
      // Await the expression result as executeJavaScript does, including returned promises.
      return await window.webContents.executeJavaScript(script);
    } catch {
      markStep(`learner-profile:evaluate:${phase}:failed`);
      throw new Error(`个人档案页面执行失败（${phase}）`);
    }
  };
  const original = await serviceRequest('GET', '/api/study/identity');
  const uid = original.uid;
  assert(
    original.registrationStatus === 'local_only' && original.canInvite === false,
    '离线 UID 被错误标记为可邀请',
  );
  const unauthorized = await fetch(`${origin}/api/study/identity`);
  assert(unauthorized.status === 401, '匿名请求读取了个人身份');
  const attemptsBefore = await serviceRequest('GET', '/api/study/attempts?kind=real');
  await window.loadURL(`${origin}/profile`);
  const wait = async (script, message, phase) => {
    const deadline = Date.now() + 20000;
    try {
      while (Date.now() < deadline) {
        if (await evaluate(script, `wait:${phase}`)) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    } catch (error) {
      markStep(`learner-profile:wait:${phase}:failed`);
      if (error instanceof Error && error.message.startsWith('个人档案页面执行失败（')) throw error;
      throw new Error(`个人档案等待失败（${phase}）`);
    }
    markStep(`learner-profile:wait:${phase}:failed`);
    throw new Error(message);
  };
  if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
  const click = async (selector, phase) => {
    const encoded = JSON.stringify(selector);
    try {
      await wait(
        `Boolean(document.querySelector(${encoded})) && !document.querySelector(${encoded}).disabled`,
        '个人档案控件不可用',
        `${phase}:enabled`,
      );
      await evaluate(
        `document.querySelector(${encoded}).scrollIntoView({block:'center',behavior:'instant'})`,
        `click:${phase}:scroll`,
      );
      await evaluate(
        'new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)))',
        `click:${phase}:paint`,
      );
      const position = await evaluate(
        `(() => {const node=document.querySelector(${encoded});const b=node.getBoundingClientRect();
        const x=Math.round(b.left+b.width/2),y=Math.round(b.top+b.height/2);const hit=document.elementFromPoint(x,y);
        if(hit!==node&&!node.contains(hit))throw new Error('个人控件被遮挡');return {x,y};})()`,
        `click:${phase}:position`,
      );
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        try {
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type,
            ...position,
            button: type === 'mouseMoved' ? 'none' : 'left',
            clickCount: 1,
          });
        } catch {
          throw new Error(`个人档案控件点击失败（${phase}:dispatch）`);
        }
      }
    } catch (error) {
      markStep(`learner-profile:click:${phase}:failed`);
      throw error;
    }
  };
  const name = async (value) =>
    evaluate(
      `(() => {const input=document.querySelector('[data-learner-name]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      'set-name',
    );
  markStep('learner-profile:initial-render');
  await wait(
    `document.querySelector('[data-learner-uid]')?.value===${JSON.stringify(uid)}`,
    '个人页面未显示实际 UID',
    'initial-uid',
  );
  assert(
    await evaluate('document.querySelector("[data-learner-uid]").readOnly', 'uid-readonly'),
    '个人 UID 可以编辑',
  );
  assert(
    await evaluate(
      'document.body.textContent.includes("未通过本人认证时不能联网邀请")',
      'offline-invite-copy',
    ),
    '离线邀请边界没有呈现',
  );

  // Restore common clipboard formats after the real browser copy. Unknown user
  // formats are left untouched; the failure UI is still exercised below.
  const formats = clipboard.availableFormats();
  if (
    formats.every((format) => ['text/plain', 'text/html', 'text/rtf', 'image/png'].includes(format))
  ) {
    const prior = {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
    };
    const image = clipboard.readImage();
    if (!image.isEmpty()) prior.image = image;
    try {
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
        enabled: true,
      });
      await evaluate(
        `(() => {
          const target = ${JSON.stringify(uid)};
          const clipboardApi = navigator.clipboard;
          const writeText = clipboardApi.writeText.bind(clipboardApi);
          window.__learnerClipboardWriteDiagnostics = {
            calls: 0,
            argumentMatches: false,
            resolved: false,
            rejected: false,
          };
          Object.defineProperty(clipboardApi, 'writeText', {
            configurable: true,
            value: async (text) => {
              const diagnostic = window.__learnerClipboardWriteDiagnostics;
              diagnostic.calls += 1;
              diagnostic.argumentMatches = text === target;
              try {
                const result = await writeText(text);
                diagnostic.resolved = true;
                return result;
              } catch (error) {
                diagnostic.rejected = true;
                throw error;
              }
            },
          });
        })()`,
        'clipboard-wrap-real-write',
      );
      markStep('learner-profile:clipboard-copy');
      await click('[data-copy-uid]', 'copy-uid');
      await wait(
        'document.querySelector("[data-learner-profile-message]")?.textContent.includes("UID 已复制")',
        '真实复制没有成功反馈',
        'copy-feedback',
      );
      const writeDiagnostics = await evaluate(
        '({...window.__learnerClipboardWriteDiagnostics})',
        'clipboard-write-diagnostics',
      );
      let immediateText;
      let immediateReadable = false;
      try {
        immediateText = clipboard.readText();
        immediateReadable = typeof immediateText === 'string';
      } catch {}
      const immediateMatches = immediateReadable && immediateText === uid;
      if (!immediateMatches) {
        let shortReadbackReadable = false;
        let shortReadbackMatches = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 75));
          try {
            const text = clipboard.readText();
            shortReadbackReadable ||= typeof text === 'string';
            shortReadbackMatches ||= typeof text === 'string' && text === uid;
            if (shortReadbackMatches) break;
          } catch {}
        }
        let rendererReadable = false;
        let rendererMatches = false;
        try {
          const rendererRead = await evaluate(
            `Promise.race([
            (async () => {
              try {
                if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') return {readable:false,matches:false};
                const text = await navigator.clipboard.readText();
                return {readable:typeof text === 'string',matches:typeof text === 'string' && text === ${JSON.stringify(uid)}};
              } catch { return {readable:false,matches:false}; }
            })(),
            new Promise(resolveTimeout => setTimeout(() => resolveTimeout({readable:false,matches:false}), 500))
          ])`,
            'clipboard-renderer-read',
          );
          rendererReadable = rendererRead?.readable === true;
          rendererMatches = rendererRead?.matches === true;
        } catch {}
        markStep('learner-profile:clipboard-diagnostic', {
          clipboardDiagnostics: {
            immediateReadable,
            immediateMatches,
            shortReadbackReadable,
            shortReadbackMatches,
            rendererReadable,
            rendererMatches,
          },
        });
      } else {
        markStep('learner-profile:clipboard-validation');
      }
      assert(
        immediateMatches,
        `复制的 UID 与服务身份不一致；writeText calls=${writeDiagnostics?.calls ?? 0}, argumentMatches=${writeDiagnostics?.argumentMatches === true}, resolved=${writeDiagnostics?.resolved === true}, rejected=${writeDiagnostics?.rejected === true}`,
      );
      cover(
        'learner UID: real Chromium clipboard copy matches service identity and restores prior supported formats',
      );
    } finally {
      clipboard.write(prior);
    }
  } else cover('learner UID: unknown clipboard formats preserved; live OS copy skipped');
  await evaluate(
    `Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new Error('clipboard denied')}})`,
    'deny-copy-write',
  );
  await click('[data-copy-uid]', 'copy-failure');
  await wait(
    'document.querySelector("[role=alert]")?.textContent.includes("手动复制")',
    '复制失败仍然显示成功',
    'copy-failure-feedback',
  );
  markStep('learner-profile:rename');
  await name('桌面昵称回归');
  await click('[data-save-learner-name]', 'save-name');
  await wait(
    'document.querySelector("[data-learner-profile-message]")?.textContent.includes("昵称已保存")',
    '真实昵称表单没有保存',
    'save-name-feedback',
  );
  const renamed = await serviceRequest('GET', '/api/study/identity');
  assert(renamed.uid === uid && renamed.displayName === '桌面昵称回归', '更名改变了 UID 或未写入');

  await serviceRequest('PUT', '/api/study/identity', {
    displayName: '另一窗口的昵称',
    expectedUid: uid,
    expectedRevision: renamed.revision,
  });
  await name('旧表单不应覆盖');
  await click('[data-save-learner-name]', 'stale-save');
  await wait(
    'document.querySelector("[role=alert]")?.textContent.includes("个人档案已更新")',
    '旧版本表单没有提示冲突',
    'stale-save-conflict',
  );
  assert(
    await evaluate(
      'document.querySelector("[data-save-learner-name]").disabled',
      'save-disabled-after-conflict',
    ),
    '版本冲突后仍可覆盖保存',
  );
  const reloaded = await serviceRequest('GET', '/api/study/identity');
  assert(reloaded.displayName === '另一窗口的昵称', '旧表单覆盖了最新昵称');
  await click('[data-learner-profile] > button:last-of-type', 'reread');
  await wait(
    'document.querySelector("[data-learner-name]")?.value==="另一窗口的昵称"',
    '重新读取没有恢复最新昵称',
    'reread-latest-name',
  );
  cover(
    'learner profile: native form rename keeps UID; stale version refuses overwrite; reread unlocks current profile',
  );

  await serviceRequest('POST', '/internal/project', { action: 'close' });
  await window.loadURL(`${origin}/no-project`);
  await wait(
    `Boolean(document.querySelector('a[href="/profile"]'))`,
    '无项目页面没有个人入口',
    'empty-profile-link',
  );
  await click('a[href="/profile"]', 'empty-profile-link');
  await wait(
    `document.querySelector('[data-learner-uid]')?.value===${JSON.stringify(uid)}`,
    '无项目时身份改变或不可读取',
    'empty-profile-uid',
  );
  await serviceRequest('POST', '/internal/project', {
    action: 'open',
    path: join(projectDirectory, 'uid-other-subject'),
  });
  const other = await serviceRequest('GET', '/api/study/state');
  await serviceRequest('PATCH', '/api/study/project', {
    scope: { projectId: other.project.projectId, generation: other.project.generation },
    subject: '物理',
    displayName: '第二科目',
  });
  assert(
    (await serviceRequest('GET', '/api/study/identity')).uid === uid,
    '科目切换或改名改变了 UID',
  );
  await serviceRequest('POST', '/internal/project', { action: 'open', path: projectDirectory });
  const attemptsAfter = await serviceRequest('GET', '/api/study/attempts?kind=real');
  assert(
    JSON.stringify(attemptsAfter) === JSON.stringify(attemptsBefore),
    'UID 跨科目测试改变了旧作答或收据',
  );
  assert((await serviceRequest('GET', '/api/study/identity')).uid === uid, '项目重开丢失 UID');
  cover(
    'learner UID: empty-state entry, subject switch/rename and project reopen keep the same identity and immutable attempts',
  );
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {
    enabled: false,
  });
  window.webContents.debugger.detach();
  await window.loadURL(`${origin}/workbench`);
  await wait(
    'document.body.textContent.includes("关闭项目")',
    '个人档案回归未返回工作台',
    'return-to-workbench',
  );
};
