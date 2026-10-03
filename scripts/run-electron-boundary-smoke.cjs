/* Node-side launcher for the hidden Electron smoke; it records only status. */
const { spawn } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');

const root = resolve(__dirname, '..');
const electron = join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
const entry = join(__dirname, 'smoke-electron-boundary.cjs');
const maxWaitMs = 90000;
let tempDir;
let child;
let succeeded = false;

const cleanup = async () => {
  let latestResult = null;
  const resultFile = tempDir && join(tempDir, 'result.json');
  if (resultFile && existsSync(resultFile)) {
    try { latestResult = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { /* partial breadcrumb */ }
  }
  const killTree = async (pid) => {
    if (!pid) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      await new Promise((resolveKill) => killer.once('exit', resolveKill));
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
    }
  };

  if (child && child.exitCode === null && child.pid) {
    await killTree(child.pid);
    child.kill();
  }
  if (!succeeded && latestResult && Number.isInteger(latestResult.servicePid)) {
    await killTree(latestResult.servicePid);
  }
  if (tempDir) {
    const absoluteTemp = resolve(tempDir);
    const safeBase = resolve(tmpdir()) + sep;
    if (absoluteTemp.startsWith(safeBase) && absoluteTemp.includes('sew-electron-smoke-runner-')) {
      rmSync(absoluteTemp, { recursive: true, force: true });
    }
  }
};

const run = async () => {
  if (!existsSync(electron)) throw new Error('Electron 38 executable is missing');
  if (!existsSync(entry)) throw new Error('Electron smoke entry is missing');
  tempDir = mkdtempSync(join(tmpdir(), 'sew-electron-smoke-runner-'));
  const resultFile = join(tempDir, 'result.json');
  const env = {
    ...process.env,
    SEW_ELECTRON_SMOKE_RESULT: resultFile,
    SEW_ELECTRON_SMOKE_USER_DATA: join(tempDir, 'profile'),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  child = spawn(electron, [entry], {
    cwd: root,
    env,
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  });

  let launchError = null;
  let childExitCode = null;
  let childExitAt = null;
  child.once('error', (error) => { launchError = error; });
  child.once('exit', (code) => {
    childExitCode = code;
    childExitAt = Date.now();
  });
  const deadline = Date.now() + maxWaitMs;
  let result = null;
  while (Date.now() < deadline) {
    if (existsSync(resultFile)) {
      try {
        const parsed = JSON.parse(readFileSync(resultFile, 'utf8'));
        if (parsed.state === 'passed' || parsed.state === 'failed') result = parsed;
      } catch { /* A partial status write is retried. */ }
    }
    if (launchError) throw new Error('Electron process could not be launched');
    if (result && child.exitCode !== null) break;
    if (childExitAt && !result && Date.now() - childExitAt > 5000) {
      let breadcrumb = 'missing';
      if (existsSync(resultFile)) {
        try {
          const parsed = JSON.parse(readFileSync(resultFile, 'utf8'));
          breadcrumb = `${parsed.state}; step=${parsed.step || 'unknown'}; electron=${parsed.electronVersion || 'none'}; appApi=${Boolean(parsed.appApiAvailable)}; servicePid=${parsed.servicePid || 'none'}`;
        } catch { breadcrumb = 'unreadable'; }
      }
      throw new Error(`Electron exited before smoke completion (code ${childExitCode}; breadcrumb ${breadcrumb})`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  if (!result) throw new Error('Electron smoke did not write a completion status before timeout');
  if (result.state !== 'passed') throw new Error(`Electron smoke failed: ${result.message || 'unspecified failure'}`);
  if (child.exitCode !== 0) throw new Error(`Electron smoke did not exit successfully (code ${child.exitCode})`);
  return result.message;
};

run()
  .then((message) => { succeeded = true; console.log(`PASS ${message}`); })
  .catch((error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : 'Electron smoke failed'}`);
    process.exitCode = 1;
  })
  .finally(() => cleanup().catch(() => { process.exitCode = 1; }));
