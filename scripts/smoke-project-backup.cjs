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
  await wait('Boolean(document.querySelector("#model-base-url"))', '模型设置未加载');
  const fill = async (selector, value) =>
    evaluate(
      `(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  await fill('#model-base-url', 'https://model-fixture.invalid/v1');
  await fill('#model-name', 'fixture-model');
  await fill('#model-api-key', 'fixture-only-not-a-real-secret');
  await evaluate('document.querySelector("[data-model-configure]").click()');
  await waitForText(
    '当前系统加密不可用，密钥仅在本次应用会话内保存',
    '首次模型配置丢失仅会话保存回执',
  );
  assert(
    await evaluate('document.querySelector("#model-api-key").value === ""'),
    '配置后密钥没有清空',
  );
  await fill('#model-name', 'fixture-model-revised');
  await fill('#model-api-key', 'fixture-only-not-a-real-secret');
  await evaluate('document.querySelector("[data-model-configure]").click()');
  await wait(
    'document.querySelector("[data-model-status]")?.textContent.includes("fixture-model-revised") && document.body.textContent.includes("当前系统加密不可用，密钥仅在本次应用会话内保存")',
    '修改模型后的状态与回执不一致',
  );
  const modelStatus = await serviceRequest('GET', '/api/study/models');
  assert(
    modelStatus.model === 'fixture-model-revised' && modelStatus.persisted === false,
    '模型状态与实际 native 配置不符',
  );
  cover(
    'model settings: initial and changed configuration retain receipt, session-only warning and clear secret without remote calls',
  );
  await window.loadURL(`${origin}/workbench`);
};
