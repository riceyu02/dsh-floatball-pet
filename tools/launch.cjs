/**
 * Launcher for the floating ball.
 *
 * Start order matters:
 *
 *   1. The **focus helper** (tools/focus-agent.cjs) is started first, from this
 *      process, so it inherits a full token. The pet cannot raise the DSH window
 *      by itself whenever it has to run with `--no-sandbox`, because that flag
 *      leaves it with a restricted token; the helper does it on the pet's behalf.
 *      (The pet now starts this helper itself too, for the packaged build that has
 *      no launcher — here it is simply started earlier and with a better token.)
 *   2. Plain Electron is tried next, because a full token also lets the pet do
 *      its own process probing.
 *   3. Chromium's sandbox cannot initialise on some machines (and always fails
 *      when the install path contains non-ASCII characters). That failure is
 *      silent — the process dies before any of our code runs — so we look again
 *      after a moment and fall back to `--no-sandbox` if it vanished.
 *
 * Two flags pin that behaviour down, so "which mode am I running" is something the
 * user chose rather than something the launcher guessed:
 *
 *   --strict-sandbox    never fall back; report the failure instead
 *   --force-no-sandbox  skip the normal attempt entirely
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const PROBE_MS = 4000;

if (!fs.existsSync(exe)) {
  console.error(`找不到 Electron：${exe}`);
  console.error('请先在项目根目录执行：  npm install');
  process.exit(1);
}

const passthrough = process.argv.slice(2);
const strictSandbox = passthrough.includes('--strict-sandbox');
const forceNoSandbox = passthrough.includes('--force-no-sandbox');
// Electron would not understand these, so they are handled here and dropped.
const extra = passthrough.filter((a) => a.startsWith('--') && a !== '--strict-sandbox' && a !== '--force-no-sandbox');
const userDataArg = extra.find((a) => a.startsWith('--user-data-dir='));
// Electron's userData for this app is %APPDATA%\<productName> unless overridden;
// the helper needs the same directory to drop its handshake file in.
const stateDir = userDataArg
  ? userDataArg.split('=')[1]
  : path.join(process.env.APPDATA || path.join(root, 'tools', '.userdata'), 'DSH 悬浮球');

fs.mkdirSync(stateDir, { recursive: true });
const consoleLog = path.join(stateDir, 'pet-console.log');

function baseEnv() {
  const env = { ...process.env };
  // ELECTRON_RUN_AS_NODE turns electron.exe into a plain Node interpreter, which
  // is never what we want when launching the app.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.DSH_PET_STATE_DIR = stateDir;
  return env;
}

function spawnDetached(command, argv, logFile) {
  const out = fs.openSync(logFile, 'a');
  fs.writeSync(out, `\n=== ${new Date().toISOString()} :: ${path.basename(command)} ${argv.join(' ')} ===\n`);
  const child = spawn(command, argv, {
    env: baseEnv(),
    detached: true,
    stdio: ['ignore', out, out],
    cwd: root,
  });
  child.unref();
  return child;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startFocusAgent() {
  const agent = path.join(__dirname, 'focus-agent.cjs');
  if (!fs.existsSync(agent)) return;
  // Normally the stale handshake is cleared so the helper definitely rewrites it.
  // Not when the pet started a helper itself: that one may be starting right now,
  // and deleting its file would only make it look dead to everyone for a moment.
  if (!process.env.DSH_PET_STATE_DIR) {
    try {
      fs.rmSync(path.join(stateDir, 'focus-agent.json'), { force: true });
    } catch { /* ignore */ }
  }
  spawnDetached(process.execPath, [agent], path.join(stateDir, 'focus-agent.log'));
}

console.log('启动 DSH 悬浮球…');
if (!forceNoSandbox) startFocusAgent();

const args = [root, `--user-data-dir=${stateDir}`, ...extra.filter((a) => !a.startsWith('--user-data-dir='))];

function reportStarted(pid, mode) {
  console.log(`已启动，pid=${pid}（${mode}）`);
  console.log(`  运行日志：${path.join(stateDir, 'pet.log')}`);
}

if (forceNoSandbox) {
  const child = spawnDetached(exe, [...args, '--no-sandbox'], consoleLog);
  setTimeout(() => {
    if (alive(child.pid)) {
      reportStarted(child.pid, '兼容模式');
      console.log('  提示：点击悬浮球唤起 DSH 会交给 tools/focus-agent.cjs 代劳。');
    } else {
      console.error('兼容模式没能启动，请看日志：');
      console.error(`  ${consoleLog}`);
      process.exit(1);
    }
  }, PROBE_MS);
} else {
  let child = spawnDetached(exe, args, consoleLog);
  setTimeout(() => {
    if (alive(child.pid)) {
      reportStarted(child.pid, '标准模式，功能完整');
      return;
    }
    if (strictSandbox) {
      // Standard mode was asked for explicitly; a silent downgrade to a weaker
      // sandbox is exactly what this flag exists to prevent.
      console.error('标准模式无法启动（Chromium 沙箱初始化失败）。');
      console.error('这个入口不会回退到 --no-sandbox —— 请改用「启动（兼容模式）.cmd」。');
      console.error(`  运行日志：${consoleLog}`);
      process.exit(1);
    }
    console.log('标准模式无法启动（Chromium 沙箱初始化失败），改用兼容模式 --no-sandbox 重试…');
    child = spawnDetached(exe, [...args, '--no-sandbox'], consoleLog);
    setTimeout(() => {
      if (alive(child.pid)) {
        reportStarted(child.pid, '兼容模式');
        console.log('  提示：点击悬浮球唤起 DSH 会交给 tools/focus-agent.cjs 代劳。');
      } else {
        console.error('两种模式都没能启动，请看日志：');
        console.error(`  ${consoleLog}`);
        process.exit(1);
      }
    }, PROBE_MS);
  }, PROBE_MS);
}
