'use strict';
/**
 * Assemble a runnable app folder by hand, with no downloads at all.
 *
 * electron-builder insists on fetching winCodeSign (to stamp the icon and version onto
 * the exe) before it will finish, and GitHub is unreachable from this machine. But the
 * packaging it does is only this: copy the Electron runtime, drop the app into
 * resources/app, rename the launcher. Doing it directly avoids the network entirely.
 *
 * The trade-off: the exe keeps Electron's own icon and version fields, and the result
 * is a folder rather than a single self-extracting file.
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'D:\\deepseek_project\\plugin-project\\dsh-desktop-pet';
const RUNTIME = path.join(ROOT, 'node_modules', 'electron', 'dist');
// The DSH bundle builder points this at a temporary directory.  Apart from
// avoiding a second 500 MB checkout copy, that also lets it build while an old
// standalone output has restrictive Windows ACLs or is currently in use.
const OUT = process.env.DSH_PET_ASSEMBLE_OUT
  ? path.resolve(process.env.DSH_PET_ASSEMBLE_OUT)
  : path.join(ROOT, 'dist', 'DSH悬浮球');
const APP = path.join(OUT, 'resources', 'app');

if (!fs.existsSync(RUNTIME)) throw new Error('no Electron runtime at ' + RUNTIME);

// The precompiled focus routine has to be built BEFORE the output folder is cleared:
// on the machines this app targets, compiling C# at runtime is impossible (creating
// the temporary csc.exe is refused), so the DLL is what makes focusing work at all.
console.log('building the focus DLL ...');
const { build: buildFocusDll } = require('./build-focus-dll.cjs');
console.log('  PetFocus.dll:', buildFocusDll(), 'bytes');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });

// 1. the runtime
console.log('copying the Electron runtime ...');
fs.cpSync(RUNTIME, OUT, { recursive: true });

// 2. the app itself: exactly what the build config's `files` listed
console.log('copying the app ...');
fs.cpSync(path.join(ROOT, 'src'), path.join(APP, 'src'), { recursive: true });
fs.mkdirSync(path.join(APP, 'tools'), { recursive: true });
fs.cpSync(path.join(ROOT, 'tools', 'focus-agent.cjs'), path.join(APP, 'tools', 'focus-agent.cjs'));
// launch.cjs is not used by the packaged app (it starts the focus helper itself),
// but the build config lists it, so the folder matches what electron-builder would
// have produced instead of quietly differing from it.
fs.cpSync(path.join(ROOT, 'tools', 'launch.cjs'), path.join(APP, 'tools', 'launch.cjs'));
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(APP, 'package.json'));

// strip devDependencies: nothing in the app needs them, and leaving them makes the
// packaged app look like it should have a node_modules
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
delete pkg.devDependencies;
delete pkg.build;
delete pkg.scripts;
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

// 3. a launcher name that means something — the launch entries below point at it, so
// this has to happen before they are written and before the summary reads `to`.
const from = path.join(OUT, 'electron.exe');
let to = path.join(OUT, 'DSH悬浮球.exe');
if (fs.existsSync(from)) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    // AppContainer build sandboxes may allow copying an executable but deny
    // renaming it. Electron's stock name is valid for the DSH helper; only the
    // human-facing standalone build needs the branded filename.
    if (!process.env.DSH_PET_ASSEMBLE_OUT || error.code !== 'EPERM') throw error;
    to = from;
    console.warn('could not rename electron.exe in the build sandbox; keeping the stock helper name');
  }
}
const executableName = path.basename(to);

// 4. launch entries.
//
// The exe alone cannot be double-clicked reliably: on a machine where Chromium's
// sandbox fails to initialise, `--no-sandbox` has to arrive as a real command-line
// argument. Putting it in main.js is too late — the sandbox is set up before any JS
// runs, which is why launching the bare exe gives no window, no log, no error. So
// write a launcher that carries the flag, plus a standard-mode one for machines where
// the sandbox works and the flag would be a needless downgrade.
function launcher(lines) {
  return ['@echo off', 'chcp 65001 >nul', ...lines, ''].join('\r\n');
}

// These two are the user's whole answer to "which one do I click", so they say
// which is which and what the failure looks like — a bare `start` line would
// leave the choice unexplained. The comments also exist for whoever is handed
// the folder: they are visible in Notepad without any tooling.
fs.writeFileSync(path.join(OUT, '启动（标准模式）.cmd'), launcher([
  'rem ===========================================================================',
  'rem  DSH 悬浮球 —— 标准模式（优先点这个）',
  'rem',
  'rem  不加 --no-sandbox：Chromium 沙箱保持开启，进程权限完整。',
  'rem  沙箱正常的机器上就该用这个 —— 带 --no-sandbox 是白降安全性。',
  'rem',
  'rem  如果双击后什么都没出现（进程一闪就没、日志一个字节都没写），说明这台机器',
  'rem  初始化不了 Chromium 沙箱，请改用「启动（兼容模式）.cmd」。',
  'rem  典型触发条件：程序所在路径里含中文等非 ASCII 字符。',
  'rem ===========================================================================',
  `start "" "%~dp0${executableName}"`,
]));

fs.writeFileSync(path.join(OUT, '启动（兼容模式）.cmd'), launcher([
  'rem ===========================================================================',
  'rem  DSH 悬浮球 —— 兼容模式（标准模式双击没反应时才用）',
  'rem',
  'rem  把 --no-sandbox 作为**真正的命令行参数**传给 exe，这一点是必须的：',
  "rem  main.js 里的 app.commandLine.appendSwitch('no-sandbox') 太晚了 ——",
  'rem  沙箱在 JS 执行之前就初始化并失败了，进程会直接静默退出。',
  'rem',
  'rem  代价：--no-sandbox 会让本进程拿到受限令牌，它自己抢不到 DSH 的前台；',
  'rem  这件事由焦点帮手 tools\\focus-agent.cjs 代劳 —— 悬浮球启动时会自己把',
  'rem  帮手拉起来（用 DSH悬浮球.exe + ELECTRON_RUN_AS_NODE=1 当 Node 用），',
  'rem  不用你管，对方机器上也不需要装 Node。',
  'rem ===========================================================================',
  'rem  DSH_PET_NO_SANDBOX 是给 main.js 看的：进程建起来之后没法再补这个开关，',
  'rem  而应用需要知道「沙箱是被主动关掉的」，才能不去指望编译 C# 的那条路。',
  'set "DSH_PET_NO_SANDBOX=1"',
  `start "" "%~dp0${executableName}" --no-sandbox`,
]));

// 5. the icon, next to the exe so it can be picked up later if wanted
fs.mkdirSync(path.join(OUT, 'resources', 'build'), { recursive: true });
fs.cpSync(path.join(ROOT, 'build', 'icon.ico'), path.join(OUT, 'resources', 'build', 'icon.ico'));

// 6. the precompiled focus routine, inside the app next to the code that loads it.
//
// src/dsh.js resolves it as `<this file's folder>/PetFocus.dll`, which is the same
// relative location for a packaged app (`app.asar/src`) and a hand-assembled one
// (`resources/app/src`) — a sibling folder would resolve differently in each.
fs.cpSync(path.join(ROOT, 'build', 'PetFocus.dll'), path.join(APP, 'src', 'PetFocus.dll'));

function sizeOf(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

console.log('');
console.log('built:', OUT);
console.log('launcher:', fs.existsSync(to) ? executableName : '*** MISSING ***');
console.log('app files:', fs.readdirSync(APP).join(', '));
console.log('assets:', fs.readdirSync(path.join(APP, 'src', 'renderer', 'assets')).join(', '));
console.log('total size:', (sizeOf(OUT) / 1024 / 1024).toFixed(0), 'MB');
