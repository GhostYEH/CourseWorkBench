/* Current-stage regression using the production service and sandboxed Electron
 * renderer. Fixture evidence is synthetic; no provider or online peers are used. */
const assert = (condition, message) => { if (!condition) throw new Error(message); };

module.exports = async ({ window, origin, projectDirectory, serviceRequest, waitForText, cover,
  execute, waitFor, click, input, lessonId, lessonVersion, quizScenes, bundleId, bundle }) => {
  let state = await serviceRequest('GET', '/api/study/state');
  let scope = { projectId: state.project.projectId, generation: state.project.generation };
  const roomQuery = (roomId) => `/api/study/rooms?${new URLSearchParams({ ...scope, ...(roomId ? { roomId } : {}) })}`;
  const roles = await serviceRequest('GET', '/api/study/roles');
  if (!roles.profiles.some(role => role.kind === 'peer')) await serviceRequest('POST', '/api/study/roles', {
    scope, action: 'create', kind: 'peer', name: '回归同学', persona: '只核对来源', explanation: 'concise',
  });
  const classroomQuery = (roomId) => `/api/study/classroom?${new URLSearchParams({ ...scope, lessonId, roomId })}`;
  const select = async (selector, value) => execute(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) throw new Error('找不到选择框');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const clickText = async (text, prefix = false) => {
    const expression = `[...document.querySelectorAll('button')].find(node => node.textContent.trim()${prefix ? '.startsWith' : ' === '}${prefix ? `(${JSON.stringify(text)})` : JSON.stringify(text)})`;
    await waitFor(`Boolean(${expression}) && !(${expression}).disabled`, `未找到可用按钮：${text}`);
    await execute(`(${expression}).setAttribute('data-stage-smoke-button','current')`);
    await click('[data-stage-smoke-button="current"]');
    await execute(`document.querySelector('[data-stage-smoke-button="current"]')?.removeAttribute('data-stage-smoke-button')`);
  };

  await window.loadURL(`${origin}/workbench/rooms`);
  await waitForText('建立个人课堂', '个人课堂页未加载');
  await waitFor(`Object.keys(document.querySelector('[data-room-lesson]') || {}).some(key => key.startsWith('__reactProps$'))`, '个人课堂页尚未完成客户端挂接');
  await select('[data-room-lesson]', lessonId);
  await click('[data-room-create]');
  await waitFor(`Boolean(document.querySelector('[data-room-id] [data-room-enter]'))`, '创建个人课堂未返回可用房间');
  const rooms = await serviceRequest('GET', roomQuery());
  const room = rooms.rooms.find(item => item.course.lessonId === lessonId);
  assert(room && room.course.lessonVersion === lessonVersion && room.members.length === 1, '个人课堂没有冻结课程版本与本人成员');
  const projected = await serviceRequest('GET', roomQuery(room.roomId));
  assert(projected.snapshot.scenes.every(scene => scene.type !== 'slide' || scene.elements.every(element => !Object.hasOwn(element, 'html'))), '共享课件仍含任意 HTML');
  const projectionText = JSON.stringify(projected.snapshot);
  assert(!projectionText.includes('仅服务端保存的参考答案') && !projectionText.includes('仅服务端保存的解析') && !projectionText.includes('保留本人解题过程'), '房间冻结投影包含私有答案或本人过程');
  cover('local classroom: real room creation form freezes reviewed version and excludes private answers/process/HTML');

  await click(`[data-room-id="${room.roomId}"] [data-room-enter]`);
  await waitForText('开始本课', '房间课堂没有提供明确开课入口');
  await clickText('开始本课');
  await waitFor(`Boolean(document.querySelector('[data-classroom-board]'))`, '开课后白板没有加载');
  const opened = await serviceRequest('GET', classroomQuery(room.roomId));
  assert(opened.state?.session?.lessonId === lessonId && opened.state.session.stageId === room.course.stageId && opened.state.session.currentSceneId === room.currentSceneId,
    '房间开课没有绑定正确版本、课件与场景');
  const sessionId = opened.state.session.sessionId;
  await waitForText('四层核对通过', '课堂没有完成恢复核对');
  await clickText('开启 AI 同学');
  await waitFor(`document.querySelector('[data-classroom-peers]')?.textContent.includes('关闭 AI 同学')`, '同学开关没有刷新父课堂状态');
  await clickText('提问');
  await waitFor(`document.querySelector('[data-classroom-peers]')?.textContent.includes('本轮同学发言 1 次')`, '发言后同学次数没有刷新');
  const peers = await serviceRequest('GET', classroomQuery(room.roomId));
  assert(peers.state.peerTurns.length === 1 && peers.state.peerTurns[0].partition === 'simulation' && peers.state.session.roundPeerTurns === 1, '同学发言未进入simulation或计数不一致');
  assert(await execute(`document.querySelector('[data-classroom-peers]').textContent.includes(${JSON.stringify(peers.state.peerTurns[0].text)})`), '新同学发言没有出现在界面');
  await clickText('关闭 AI 同学');
  await waitFor(`document.querySelector('[data-classroom-peers]')?.textContent.includes('开启 AI 同学')`, '关闭同学后界面仍显示开启');
  assert(await execute(`[...document.querySelectorAll('[data-classroom-peers] button')].filter(button => ['提问','讨论','复述已审核示例'].includes(button.textContent.trim())).every(button => button.disabled)`), '关闭同学后发言按钮仍可用');
  cover('AI peers: native enable, one simulation turn, parent count/list refresh and disable without navigation');
  const boardQuery = () => `/api/study/board?${new URLSearchParams({ ...scope, sessionId })}`;
  await waitFor(`document.querySelector('[data-board-statement]')?.value`, '白板没有读取来源陈述');
  await click('[data-classroom-board] details > summary');
  await input('[data-board-text]', '同一区间内取 x1 < x2 时，比较 f(x1) 与 f(x2)。');
  await click('[data-board-create]');
  await waitFor(`Boolean(document.querySelector('[data-board-item] [data-board-approve]'))`, '白板草案没有保存');
  assert(await execute(`document.querySelectorAll('[data-board-effect]').length === 0`), '待审核白板进入正式画布');
  await input('[data-board-review-note]', '夹具核对：本陈述支持同区间内的比较，未增添额外结论。');
  await click('[data-board-review-confirm]');
  await click('[data-board-approve]');
  await waitFor(`Boolean(document.querySelector('[data-board-play]'))`, '人工审核后没有播放入口');
  await click('[data-board-play]');
  await waitFor(`document.querySelectorAll('[data-board-effect]').length === 1`, '审核白板未显示到画布');
  const board = await serviceRequest('GET', boardQuery());
  assert(board.state.seq === 1 && board.state.effects.length === 1 && board.state.effects[0].item.status === 'approved', '白板审核和播放效果未落库');
  cover('classroom board: native create/review/play controls keep drafts out of canvas and commit one approved effect');
  for (const kind of ['formula', 'focus']) {
    await select('[data-board-kind]', kind);
    await input('[data-board-text]', kind === 'formula' ? 'f(x)=ax+1' : '请注意本场景的来源陈述。');
    if (kind === 'formula') await input('[data-board-latex]', 'f(x)=ax+1');
    else await waitFor(`document.querySelector('[data-board-focus-element]')?.value`, '本场景没有可绑定的聚焦元素');
    await click('[data-board-create]');
    await waitFor(`Boolean(document.querySelector('[data-board-item] ${kind === 'formula' ? '[data-board-formula]' : '[data-board-focus]'}'))`, '新白板草案没有显示');
    const current = await serviceRequest('GET', boardQuery());
    const draft = current.state.items.find(item => item.content.kind === kind && item.status === 'draft');
    assert(draft, '白板草案没有持久化');
    await click(`[data-board-item="${draft.itemId}"] [data-board-approve]`);
    await waitFor(`Boolean(document.querySelector('[data-board-item="${draft.itemId}"] [data-board-play]'))`, '新白板草案没有完成审核');
    await click(`[data-board-item="${draft.itemId}"] [data-board-play]`);
    await waitFor(`document.querySelectorAll('[data-board-effect]').length === ${kind === 'formula' ? 2 : 3}`, '新白板内容没有显示到课堂');
    if (kind === 'formula') assert(await execute(`Boolean(document.querySelector('[data-board-canvas] [data-board-formula] .katex'))`), '公式没有使用数学排版');
    else {
      assert(current.elementIds.includes(draft.content.elementId), '聚焦内容没有绑定当前冻结场景的元素');
      // 聚焦必须在画布上真的生效：状态标记指向的元素由 SlideCanvas 渲染，并且出现高亮框。
      await waitFor(`document.querySelector('[data-canvas-focus]')?.getAttribute('data-canvas-focus') === ${JSON.stringify(draft.content.elementId)}`, '教师聚焦没有在课堂视图生效');
      const painted = await execute(`(() => ({
        inCanvas: Boolean(document.getElementById('slide-element-' + ${JSON.stringify(draft.content.elementId)})),
        overlay: Boolean(document.querySelector('[data-scene="slide"] .highlight-overlay')),
      }))()`);
      assert(painted.inCanvas, '教师聚焦指向的元素不在冻结画布里');
      assert(painted.overlay, '教师聚焦没有在画布上画出高亮');
    }
  }
  cover('board formula/focus: native approved math rendering, source-scene element binding and real canvas highlight');
  await clickText('交还本人');
  await waitForText('已恢复等待本人作答', '恢复核对没有保持等待');
  assert(await execute(`[...document.querySelectorAll('button')].find(button => button.textContent.trim()==='播放下一张讲解').disabled`), '等待本人时教师播放仍可操作');
  assert(await execute(`[...document.querySelectorAll('[data-classroom-peers] button')].filter(button => ['提问','讨论'].includes(button.textContent.trim())).every(button=>button.disabled)`), '等待本人时同学仍可操作');
  cover('four-layer recovery: native handback preserves waiting and disables teacher/peer execution');
  await clickText('本人已作答，继续');
  await waitForText('四层核对通过', '显式交还后没有重新通过恢复核对');

  await serviceRequest('POST', '/internal/project', { action: 'close' });
  const reopened = await serviceRequest('POST', '/internal/project', { action: 'open', path: projectDirectory });
  scope = { projectId: reopened.session.projectId, generation: reopened.session.generation };
  await window.loadURL(`${origin}/classroom/${encodeURIComponent(lessonId)}?room=${encodeURIComponent(room.roomId)}`);
  await waitFor(`document.querySelectorAll('[data-board-effect]').length === 3`, '数据库重开后白板未恢复或重复播放');
  const boardAgain = await serviceRequest('GET', boardQuery());
  assert(boardAgain.state.seq === 3 && boardAgain.state.effects.length === 3, '重开导致重复的白板收据');
  cover('room/board reopen: room session and approved effect restore without repeating commands');
  await click(`button.tab[data-scene-id="${quizScenes[0].sceneId}"]`);
  await clickText('切换到场景（', true);
  await waitForText('已切换到场景', '切场景命令没有返回明确结果');
  await waitFor(`!document.querySelector('[data-canvas-focus]')`, '切换场景后教师聚焦仍然高亮别的场景元素');
  const advanced = await serviceRequest('GET', roomQuery(room.roomId));
  const advancedSession = await serviceRequest('GET', classroomQuery(room.roomId));
  assert(advanced.rooms.find(item => item.roomId === room.roomId)?.currentSceneId === quizScenes[0].sceneId && advancedSession.state?.session.currentSceneId === quizScenes[0].sceneId,
    '切场景未同步房间与课堂会话');
  await clickText('结束本课');
  await waitFor(`document.body.textContent.includes('课堂已结束') || document.body.textContent.includes('该课堂已结束')`, '结束课堂未返回明确状态');
  const ended = await serviceRequest('GET', roomQuery(room.roomId));
  assert(ended.rooms.find(item => item.roomId === room.roomId)?.status === 'ended', '课堂结束未同步房间状态');
  cover('room lifecycle: native scene advance and close synchronize durable room/session state');

  // Formal experiments use another reviewed, immutable course.
  const drafted = await serviceRequest('POST', '/api/study/lessons', { scope, action: 'draft', lessonId: null,
    bundleId, title: '正式互动回归课', statementIds: bundle.statements.map(item => item.statementId), questionIds: [] });
  const interactiveLesson = drafted.lesson;
  const headers = { 'x-sew-project-id': scope.projectId, 'x-sew-generation': String(scope.generation) };
  const statementIds = [bundle.statements[0].statementId];
  await serviceRequest('POST', '/api/study/formal-interactions', { operation: 'review', scope,
    lessonId: interactiveLesson.lessonId, lessonVersion: interactiveLesson.version, semanticReviewed: true,
    reviewNote: '仅用于软件回归，审核参数与关系来源绑定，不能代替真实科目评测。', definitions: [
      { id: 'native-parameter', title: '线性参数回归', kind: 'parameter', statementIds, formula: 'linear', min: -2, max: 2, step: 1, intercept: 1, predictionRequired: true },
      { id: 'native-relation', title: '概念关系回归', kind: 'concept_relation', statementIds,
        nodes: [{ id: 'interval', label: '同一区间' }, { id: 'ordering', label: '函数值比较' }],
        edges: [{ id: 'needs', from: 'ordering', to: 'interval', label: '限定条件' }] },
    ] }, headers);
  await serviceRequest('POST', '/api/study/lessons', { scope, action: 'review', lessonId: interactiveLesson.lessonId, version: interactiveLesson.version,
    decision: 'approved', note: '核对互动夹具与冻结来源' });
  await serviceRequest('POST', '/api/study/lessons', { scope, action: 'publish', lessonId: interactiveLesson.lessonId, version: interactiveLesson.version });
  const attached = await serviceRequest('POST', '/api/study/lessons', { scope, action: 'attach-document', lessonId: interactiveLesson.lessonId, version: interactiveLesson.version });
  const interactionScenes = attached.document.scenes.filter(scene => scene.sceneType === 'interactive');
  assert(interactionScenes.length === 2, '已审核正式互动没有加入课件');
  const knowledgeBefore = await serviceRequest('GET', '/api/study/knowledge');
  await window.loadURL(`${origin}/classroom/${encodeURIComponent(interactiveLesson.lessonId)}`);
  await waitForText('正式互动回归课', '正式互动课堂未加载');
  for (const scene of interactionScenes) {
    await click(`button.tab[data-scene-id="${scene.sceneId}"]`);
    await waitFor(`Boolean(document.querySelector('[data-formal-interaction] [data-formal-submit]')) && !document.querySelector('[data-formal-submit]').disabled`, '正式互动组件没有加载');
    if (scene.sceneId.endsWith('native-parameter')) {
      await input('[data-formal-parameter]', '2'); await input('[data-formal-x]', '3');
      await input('[data-formal-prediction]', '7');
    } else { await select('[data-formal-target]', 'interval'); }
    await input('[data-formal-explanation]', '本人观察解释：对照已审核的定义与必要条件。');
    await clickText('保存临时草稿');
    await waitForText('本版本临时草稿已保存', '正式互动临时草稿没有保存');
    await click('[data-formal-submit]');
    await waitFor(`document.querySelector('[data-formal-result]')?.textContent.includes('共 1 条')`, '正式互动提交没有获得持久化收据');
    const resultText = await execute(`document.querySelector('[data-formal-result]').textContent`);
    assert(resultText.includes(scene.sceneId.endsWith('native-parameter') ? '核验：7' : '核验：关系核验一致'), '服务没有核验本人参数或关系');
    if (scene.sceneId.endsWith('native-parameter')) assert(resultText.includes('本人预测与实测一致'), '预测没有经过服务核验');
    cover(`formal interaction ${scene.sceneId.endsWith('native-parameter') ? 'parameter' : 'concept relation'}: native input, draft, SVG and verified personal submission`);
  }
  const knowledgeAfter = await serviceRequest('GET', '/api/study/knowledge');
  assert(JSON.stringify(knowledgeAfter) === JSON.stringify(knowledgeBefore), '互动观察直接修改掌握或知识记录');
  await serviceRequest('POST', '/internal/project', { action: 'close' });
  const lastReopen = await serviceRequest('POST', '/internal/project', { action: 'open', path: projectDirectory });
  scope = { projectId: lastReopen.session.projectId, generation: lastReopen.session.generation };
  await window.loadURL(`${origin}/classroom/${encodeURIComponent(interactiveLesson.lessonId)}`);
  await waitForText('正式互动回归课', '重开后互动课堂未加载');
  for (const scene of interactionScenes) {
    await click(`button.tab[data-scene-id="${scene.sceneId}"]`);
    await waitFor(`document.querySelector('[data-formal-result]')?.textContent.includes('共 1 条')`, '重开丢失互动收据或重复计数');
    assert(await execute(`document.querySelector('[data-formal-explanation]')?.value.includes('本人观察解释')`), '重开丢失本人互动解释');
    if (scene.sceneId.endsWith('native-parameter')) assert(await execute(`document.querySelector('[data-formal-prediction]')?.value === '7'`), '重开丢失独立预测');
  }
  cover('formal interaction reopen: UID-bound personal values/receipts restore once and observations leave mastery unchanged');
  const interactiveRoom = await serviceRequest('POST', '/api/study/rooms', { scope,
    lessonId: interactiveLesson.lessonId, lessonVersion: interactiveLesson.version, requestId: 'native-interactive-room' });
  const shared = await serviceRequest('GET', roomQuery(interactiveRoom.room.roomId));
  const publicInteractive = shared.snapshot.scenes.filter(scene => scene.type === 'interactive');
  assert(publicInteractive.length === 2 && publicInteractive.some(scene => scene.interaction.kind === 'parameter' && scene.interaction.predictionRequired), '公开互动定义没有保留版本预测要求');
  const publicText = JSON.stringify(shared.snapshot);
  assert(!publicText.includes('"to":"interval"') && !publicText.includes('本人观察解释') && !publicText.includes('<!doctype html>'), '公开互动投影泄露正确关系、私人观察或任意HTML');
  cover('interactive room projection: production HTTP shares reviewed definitions without relation targets, personal observations or HTML');
};
