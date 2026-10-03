/**
 * 项目协调器（《Electron 开发设计》第 4、5 节）。
 *
 * 职责：项目打开/关闭、代次归属、scope 计算、材料授权在途计数。
 *
 * 边界：项目身份与代次由本地服务分配，本模块只持有当前会话快照。
 * 同路径重开也重新分配代次，不能用目录字符串判断身份。
 * 共享状态只有这里一处：窗口/设置由调用方通过回调接入，不在此复制。
 */

const createProjectCoordinator = ({ service, onProjectChanged }) => {
  let project = null;
  let materialGrantCount = 0;
  let materialGrantIdle = null;
  let resolveMaterialGrantIdle = null;

  const current = () => project;

  const scopeOf = () => ({
    projectId: project ? project.projectId : '',
    generation: project ? project.generation : 0,
  });

  const sameScope = (left, right) =>
    left.projectId === right.projectId && left.generation === right.generation;

  const waitForGrants = async () => {
    while (materialGrantIdle) await materialGrantIdle;
  };

  /** 发放操作级授权计数：在途期间切换/关闭项目需等待，避免旧请求写入新项目。 */
  const beginGrant = () => {
    if (materialGrantCount === 0) {
      materialGrantIdle = new Promise((resolvePromise) => {
        resolveMaterialGrantIdle = resolvePromise;
      });
    }
    materialGrantCount += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      materialGrantCount -= 1;
      if (materialGrantCount === 0) {
        const resolvePromise = resolveMaterialGrantIdle;
        materialGrantIdle = null;
        resolveMaterialGrantIdle = null;
        resolvePromise?.();
      }
    };
  };

  /** 启动时接管服务已在使用的项目会话（不重写最近项目记录）。 */
  const adopt = (session) => {
    project = { ...session };
    return project;
  };

  const open = async (rootPath) => {
    await waitForGrants();
    const data = await service.request('POST', '/internal/project', { action: 'open', path: rootPath });
    project = { ...data.session };
    onProjectChanged(project);
    return project;
  };

  const close = async () => {
    await waitForGrants();
    await service.request('POST', '/internal/project', { action: 'close' });
    project = null;
    onProjectChanged(null);
  };

  return {
    current,
    scopeOf,
    sameScope,
    waitForGrants,
    beginGrant,
    adopt,
    open,
    close,
  };
};

module.exports = { createProjectCoordinator };
