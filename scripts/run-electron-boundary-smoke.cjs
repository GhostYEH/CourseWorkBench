/* Node-side launcher for the hidden Electron smoke; it records only status. */
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');

const root = resolve(__dirname, '..');
const suites = ['boundary', 'lesson-plan'];
const args = process.argv.slice(2);
let suite;
if (args.length === 0) {
  for (const nextSuite of suites) {
    const launched = spawnSync(process.execPath, [__filename, '--suite', nextSuite], {
      cwd: root,
      windowsHide: true,
      stdio: 'inherit',
    });
    if (launched.error || launched.status !== 0) {
      process.exit(1);
    }
  }
  console.log('PASS hidden Electron smoke: both boundary and lesson-plan suites completed');
  process.exit(0);
} else if (args.length === 2 && args[0] === '--suite' && suites.includes(args[1])) {
  suite = args[1];
} else {
  console.error(
    'FAIL usage: node scripts/run-electron-boundary-smoke.cjs [--suite boundary|lesson-plan]',
  );
  process.exit(1);
}
const electron = join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
const entry = join(__dirname, 'smoke-electron-boundary.cjs');
const maxWaitMs = 240000;
let tempDir;
let child;
let succeeded = false;

const formatResultDetails = (result) => {
  if (!result || typeof result !== 'object') return '';
  const details = [];
  if (typeof result.step === 'string') details.push(`step=${result.step}`);
  const diagnostics =
    result.clipboardDiagnostics && typeof result.clipboardDiagnostics === 'object'
      ? result.clipboardDiagnostics
      : null;
  if (diagnostics) {
    details.push(
      `clipboardDiagnostics=${JSON.stringify({
        immediateReadable: diagnostics.immediateReadable === true,
        immediateMatches: diagnostics.immediateMatches === true,
        shortReadbackReadable: diagnostics.shortReadbackReadable === true,
        shortReadbackMatches: diagnostics.shortReadbackMatches === true,
        rendererReadable: diagnostics.rendererReadable === true,
        rendererMatches: diagnostics.rendererMatches === true,
      })}`,
    );
  }
  return details.length ? `; ${details.join('; ')}` : '';
};

const cleanup = async () => {
  let latestResult = null;
  const resultFile = tempDir && join(tempDir, 'result.json');
  if (resultFile && existsSync(resultFile)) {
    try {
      latestResult = JSON.parse(readFileSync(resultFile, 'utf8'));
    } catch {
      /* partial breadcrumb */
    }
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
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
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
    SEW_ELECTRON_SMOKE_SUITE: suite,
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
  let latestResult = null;
  child.once('error', (error) => {
    launchError = error;
  });
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
        latestResult = parsed;
        if (parsed.state === 'passed' || parsed.state === 'failed') result = parsed;
      } catch {
        /* A partial status write is retried. */
      }
    }
    if (launchError) throw new Error('Electron process could not be launched');
    if (result && child.exitCode !== null) break;
    if (childExitAt && !result && Date.now() - childExitAt > 5000) {
      let breadcrumbState = 'missing';
      if (existsSync(resultFile)) {
        try {
          latestResult = JSON.parse(readFileSync(resultFile, 'utf8'));
          breadcrumbState = latestResult.state || 'unknown';
        } catch {
          breadcrumbState = 'unreadable';
        }
      }
      const breadcrumb = `${breadcrumbState}; electron=${latestResult?.electronVersion || 'none'}; appApi=${Boolean(latestResult?.appApiAvailable)}; servicePid=${latestResult?.servicePid || 'none'}${formatResultDetails(latestResult)}`;
      throw new Error(
        `Electron exited before smoke completion (code ${childExitCode}; breadcrumb ${breadcrumb})`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  if (!result) {
    throw new Error(
      `Electron smoke did not write a completion status before timeout${formatResultDetails(latestResult)}`,
    );
  }
  if (result.state !== 'passed') {
    throw new Error(
      `Electron smoke failed: ${result.message || 'unspecified failure'}${formatResultDetails(latestResult || result)}`,
    );
  }
  if (child.exitCode !== 0)
    throw new Error(`Electron smoke did not exit successfully (code ${child.exitCode})`);
  return result.message;
};

run()
  .then((message) => {
    succeeded = true;
    console.log(`PASS ${message}`);
  })
  .catch((error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : 'Electron smoke failed'}`);
    process.exitCode = 1;
  })
  .finally(() =>
    cleanup().catch(() => {
      process.exitCode = 1;
    }),
  );
