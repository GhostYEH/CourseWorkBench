/* Real renderer controls through production native handlers; all data is disposable. */
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

module.exports = async ({
  window,
  origin,
  backupWorkspace,
  serviceRequest,
  waitForText,
  cover,
}) => {
  await window.loadURL(`${origin}/workbench/settings`);
  await waitForText('项目备份与恢复', '备份入口未显示');
  const evaluate = (script) => window.webContents.executeJavaScript(script);
  const wait = async (script, message) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await evaluate(script)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(message);
  };
  const diagnosticError = (step, detail) => {
    return new Error(`model ${step}: ${detail}`);
  };
  const safeErrorKind = (error) => {
    const name = error && typeof error.name === 'string' ? error.name : 'Error';
    return ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(name)
      ? name
      : 'Error';
  };
  const evaluateModel = async (step, script) => {
    let result;
    try {
      result = await evaluate(`(() => {
        try { return { ok: true, value: (${script}) }; }
        catch (error) {
          const name = error && typeof error.name === 'string' ? error.name : 'Error';
          return { ok: false, name };
        }
      })()`);
    } catch (error) {
      throw diagnosticError(step, `renderer evaluation rejected (${safeErrorKind(error)})`);
    }
    if (!result?.ok) {
      throw diagnosticError(step, `renderer threw (${safeErrorKind({ name: result?.name })})`);
    }
    return result.value;
  };
  const waitModel = async (step, script, message) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await evaluateModel(step, script)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw diagnosticError(step, message);
  };
  const assertModel = (condition, step, message) => {
    if (!condition) throw diagnosticError(step, message);
  };
  const modelServiceRequest = async (step) => {
    try {
      return await serviceRequest('GET', '/api/study/models');
    } catch (error) {
      throw diagnosticError(step, `service request failed (${safeErrorKind(error)})`);
    }
  };
  await wait(
    'document.querySelector("[data-project-backup]") && !document.querySelector("[data-project-backup]").disabled',
    '备份按钮不可用',
  );
  await evaluate('document.querySelector("[data-project-backup]").click()');
  await waitForText('项目备份已完成', '实际 native 备份未给出完成反馈');
  assert(existsSync(join(backupWorkspace, 'backup', 'backup.json')), '备份容器缺少清单');
  const active = await serviceRequest('GET', '/internal/project');
  const before = await serviceRequest('GET', '/api/study/attempts?kind=real');
  await evaluate('document.querySelector("[data-project-restore]").click()');
  await waitForText('已恢复到新目录', '实际 native 恢复未给出完成反馈');
  assert(
    existsSync(join(backupWorkspace, 'restored', '.study', 'study.db')),
    '恢复未发布完整数据库',
  );
  const after = await serviceRequest('GET', '/internal/project');
  assert(
    after.projectId === active.projectId && after.generation === active.generation,
    '恢复替换了当前项目',
  );
  assert(
    JSON.stringify(await serviceRequest('GET', '/api/study/attempts?kind=real')) ===
      JSON.stringify(before),
    '恢复改变了当前本人作答',
  );
  const originalManifest = JSON.parse(
    readFileSync(join(backupWorkspace, 'backup', 'project', 'project.json'), 'utf8'),
  );
  const restoredManifest = JSON.parse(
    readFileSync(join(backupWorkspace, 'restored', 'project.json'), 'utf8'),
  );
  assert(
    JSON.stringify(originalManifest) === JSON.stringify(restoredManifest),
    '恢复改变了项目清单身份',
  );
  cover(
    'project backup: renderer buttons, real native IPC/control route, checksummed container, new-directory restore and unchanged active answers',
  );

  // Configure only a deliberately invalid remote endpoint; no model test or inference is invoked.
  await waitModel(
    'settings loaded',
    'Boolean(document.querySelector("#model-base-url"))',
    'condition timed out',
  );
  const fill = async (selector, value) =>
    evaluateModel(
      `fill ${selector}`,
      `(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  await fill('#model-base-url', 'https://FIXTURE.invalid:443/v1/');
  await fill('#model-name', 'fixture-model');
  await fill('#model-api-key', 'fixture-only-not-a-real-secret');
  await evaluateModel(
    'first configure click',
    'document.querySelector("[data-model-configure]").click()',
  );
  await waitModel(
    'first configure receipt',
    'document.body.innerText.includes("当前系统加密不可用，密钥仅在本次应用会话内保存")',
    'condition timed out',
  );
  assertModel(
    await evaluateModel(
      'first key clear check',
      'document.querySelector("#model-api-key").value === ""',
    ),
    'first key clear check',
    '配置后密钥没有清空',
  );
  const initialModelStatus = await modelServiceRequest('first native status read');
  assertModel(
    initialModelStatus.baseUrl === 'https://fixture.invalid/v1',
    'first native URL normalization',
    'native URL 规范化后的模型状态没有被读回确认',
  );
  assertModel(
    await evaluateModel(
      'first native URL shown in UI',
      'document.body.textContent.includes("https://fixture.invalid/v1")',
    ),
    'first native URL shown in UI',
    'UI 没有显示 native 规范化后的模型地址',
  );
  await fill('#model-name', 'fixture-model-revised');
  await fill('#model-api-key', 'fixture-only-not-a-real-secret');
  await evaluateModel(
    'second configure click',
    'document.querySelector("[data-model-configure]").click()',
  );
  await waitModel(
    'second configure receipt',
    'document.querySelector("[data-model-status]")?.textContent.includes("fixture-model-revised") && document.body.textContent.includes("当前系统加密不可用，密钥仅在本次应用会话内保存")',
    'condition timed out',
  );
  const modelStatus = await modelServiceRequest('second native status read');
  assertModel(
    modelStatus.model === 'fixture-model-revised' && modelStatus.persisted === false,
    'second native configuration',
    '模型状态与实际 native 配置不符',
  );
  await fill('#model-name', 'fixture-model-readback-failure');
  await fill('#model-api-key', 'fixture-only-not-a-real-secret');
  await evaluateModel(
    'status read failure injection and third configure click',
    `(() => {
    const originalFetch = window.fetch;
    const fixture = { started: true, failed: false };
    fixture.restore = () => { window.fetch = originalFetch; fixture.started = false; };
    window.__modelStatusReadFixture = fixture;
    window.fetch = function (resource, init) {
      const rawUrl = typeof resource === 'string' ? resource : resource.url;
      const url = new URL(rawUrl, window.location.href);
      const method = (init?.method || (resource instanceof Request ? resource.method : 'GET')).toUpperCase();
      const configure = document.querySelector('[data-model-configure]');
      if (fixture.started && configure?.disabled && !fixture.failed && method === 'GET' && url.pathname === '/api/study/models') {
        fixture.failed = true;
        return Promise.resolve(Response.json({ ok: false, error: { code: 'FIXTURE_STATUS_READ_FAILED', message: 'fixture status read failed', pending: false } }, { status: 503 }));
      }
      return originalFetch.call(this, resource, init);
    };
    document.querySelector('[data-model-configure]').click();
  })()`,
  );
  await waitModel(
    'configure receipt after failed status read',
    'window.__modelStatusReadFixture?.failed && document.querySelector("#model-api-key").value === "" && document.body.textContent.includes("配置已提交，但状态读取失败")',
    'condition timed out',
  );
  assertModel(
    !(await evaluateModel(
      'native error classification',
      'document.body.textContent.includes("模型配置或测试失败")',
    )),
    'native error classification',
    '配置 native 成功后的状态读取错误被误报为原生操作失败',
  );
  const configuredDespiteReadFailure = await modelServiceRequest('status after failed read');
  assertModel(
    configuredDespiteReadFailure.model === 'fixture-model-readback-failure' &&
      configuredDespiteReadFailure.persisted === false,
    'native configuration after failed status read',
    '状态读取失败后 native 配置并未实际生效',
  );
  await evaluateModel('restore renderer fetch', 'window.__modelStatusReadFixture.restore()');
  await evaluateModel(
    'status-only retry click',
    'Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "重新读取")?.click()',
  );
  await waitModel(
    'status-only retry result',
    'document.querySelector("[data-model-status]")?.textContent.includes("fixture-model-readback-failure") && !document.body.textContent.includes("模型连接状态读取失败")',
    'condition timed out',
  );
  assertModel(
    (await modelServiceRequest('final native status read')).model ===
      'fixture-model-readback-failure',
    'final native configuration',
    '重新读取状态改变了 native 模型配置',
  );
  await evaluateModel('remove renderer fetch fixture', 'delete window.__modelStatusReadFixture');
  cover(
    'model settings: initial and changed configuration retain receipt, a failed local status read preserves the native receipt and cleared secret, and status-only retry confirms configuration without provider calls',
  );
  await window.loadURL(`${origin}/workbench`);
};
