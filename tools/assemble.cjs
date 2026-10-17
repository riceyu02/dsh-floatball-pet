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
const { createRequire } = require('module');

// Repo root, derived from this file so a fresh clone works from any path.
const ROOT = path.resolve(__dirname, '..');
// Electron's own distribution. `DSH_PET_ELECTRON_DIST` points this at a verified
// extraction elsewhere — which is how an install with no usable
// `node_modules/electron/dist` (a published tarball, where that dependency's download
// was blocked or skipped) assembles the same runtime from the release zip that
// `prepare-install.cjs` fetched and checksum-verified.
const RUNTIME = process.env.DSH_PET_ELECTRON_DIST
  ? path.resolve(process.env.DSH_PET_ELECTRON_DIST)
  : path.join(ROOT, 'node_modules', 'electron', 'dist');
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
console.log('preparing the focus DLL ...');
const { build: buildFocusDll } = require('./build-focus-dll.cjs');
console.log('  PetFocus.dll:', buildFocusDll(), 'bytes');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });

// 1. the runtime
console.log('copying the Electron runtime ...');
fs.cpSync(RUNTIME, OUT, { recursive: true });

// 2. the app itself — what the packaged helper needs at run time
console.log('copying the app ...');
fs.cpSync(path.join(ROOT, 'src'), path.join(APP, 'src'), { recursive: true });
fs.mkdirSync(path.join(APP, 'tools'), { recursive: true });
fs.cpSync(path.join(ROOT, 'tools', 'focus-agent.cjs'), path.join(APP, 'tools', 'focus-agent.cjs'));
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(APP, 'package.json'));

// strip devDependencies: nothing in the app needs them, and leaving them makes the
// packaged app look like it should have a node_modules
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
delete pkg.devDependencies;
delete pkg.scripts;
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

// 3. give Electron's stock launcher the product name, so the helper DSH spawns and any
// manual troubleshooting refer to the same executable.
const from = path.join(OUT, 'electron.exe');
let to = path.join(OUT, 'DSH悬浮球.exe');
if (fs.existsSync(from)) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    // AppContainer build sandboxes may allow copying an executable but deny
    // renaming it. Electron's stock name is still a valid helper name.
    if (!process.env.DSH_PET_ASSEMBLE_OUT || error.code !== 'EPERM') throw error;
    to = from;
    console.warn('could not rename electron.exe in the build sandbox; keeping the stock helper name');
  }
}
const executableName = path.basename(to);

// 4. the icon, next to the exe so it can be picked up later if wanted
fs.mkdirSync(path.join(OUT, 'resources', 'build'), { recursive: true });
fs.cpSync(path.join(ROOT, 'build', 'icon.ico'), path.join(OUT, 'resources', 'build', 'icon.ico'));

// 5. the precompiled focus routine, inside the app next to the code that loads it.
//
// src/dsh.js resolves it as `<this file's folder>/PetFocus.dll`, which is the same
// relative location for a packaged app (`app.asar/src`) and a hand-assembled one
// (`resources/app/src`) — a sibling folder would resolve differently in each.
fs.cpSync(path.join(ROOT, 'build', 'PetFocus.dll'), path.join(APP, 'src', 'PetFocus.dll'));

// 6. koffi, carried by the app itself.
//
// src/win32.js needs a real in-process GetWindowLong/SetWindowPos to keep the ball
// topmost against Chromium re-applying the window style ~0.7 ms after every hover or
// drag, and to run the full-screen check that makes the pet step aside for a game.
// It used to borrow a koffi from the host profile ("dsh-orb happens to ship one"),
// which made that whole path hostage to another plugin's dependency tree: measured on
// a tester's machine the active candidates pointed at `profile/node_modules/koffi` and
// `dsh-orb/node_modules/koffi`, and neither existed, so the pet silently fell back to
// the 15 s PowerShell net and the game-yield feature did not run at all.
//
// Shipping it here makes the fast path unconditional.  The binary is a prebuilt N-API
// module (no build script), ~1.0 MB next to a 269 MB runtime, and it was measured
// loading and calling Win32 inside this very Electron 33.4.11.
//
// koffi's own loader resolves the binary as
//   `${__dirname}/../../../@koromix/koffi-<platform>/<triplet>/koffi.node`
// so the platform package has to become a SIBLING of `koffi` inside the same
// node_modules.  Both that layout and a nested one were verified working inside the app.
const KOFFI_PLATFORM_PACKAGE = '@koromix/koffi-win32-x64';

/** Package root of a module, found from its resolved entry point (exports maps hide package.json). */
function packageRootOf(mainFile) {
  let dir = path.dirname(mainFile);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`no package root above ${mainFile}`);
    dir = up;
  }
}

/** Directories a module may be resolved from: the repo, then this script's own folder. */
function resolvers() {
  const roots = [ROOT, __dirname];
  return roots.map((dir) => createRequire(path.join(dir, 'package.json')));
}

/** Where koffi's package lives, preferring a copy nested under `parent` over a hoisted one. */
function findKoffiRoot(parent) {
  const candidates = [];
  if (parent) candidates.push(path.join(parent, 'node_modules', 'koffi'));
  for (const resolver of resolvers()) {
    try { candidates.push(packageRootOf(resolver.resolve('koffi'))); } catch { /* not resolvable from here */ }
  }
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'package.json'))) ?? null;
}

/** Where the matching prebuilt binary package lives. */
function findKoffiPlatformRoot(parent) {
  const candidates = [];
  if (parent) candidates.push(path.join(parent, 'node_modules', KOFFI_PLATFORM_PACKAGE));
  for (const resolver of resolvers()) {
    try { candidates.push(packageRootOf(resolver.resolve(KOFFI_PLATFORM_PACKAGE))); } catch { /* not resolvable from here */ }
  }
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'package.json'))) ?? null;
}

/**
 * The native binary koffi will actually require once it sits at `<app>/node_modules/koffi`.
 *
 * koffi resolves it relative to its own folder, so this is the property to assert rather
 * than any path we happen to have copied from.
 */
function koffiBinaryInApp(appModules) {
  return path.resolve(appModules, 'koffi', 'src', 'koffi', '..', '..', '..', KOFFI_PLATFORM_PACKAGE, 'win32_x64', 'koffi.node');
}

/**
 * Copy koffi and its prebuilt binary into the packaged app.  Throws when either half is
 * missing: a silently absent native module is exactly the failure this replaces.
 */
function copyKoffi() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.warn(`not building on win32/x64 (${process.platform}/${process.arch}); skipping koffi`);
    return false;
  }
  const koffiRoot = findKoffiRoot(ROOT);
  if (!koffiRoot) throw new Error(`koffi is not installed under ${ROOT}; run npm install (it is a devDependency)`);

  const appModules = path.join(APP, 'node_modules');
  const staged = path.join(appModules, 'koffi');
  fs.mkdirSync(appModules, { recursive: true });
  fs.cpSync(koffiRoot, staged, { recursive: true });

  // Beside koffi, in the same node_modules: that is where koffi's own loader looks, and
  // it is also a plain require target for the app.
  const platformRoot = findKoffiPlatformRoot(path.dirname(koffiRoot));
  if (!platformRoot) {
    throw new Error(`${KOFFI_PLATFORM_PACKAGE} is not installed; it is a devDependency and carries the prebuilt binary`);
  }
  fs.cpSync(platformRoot, path.join(appModules, KOFFI_PLATFORM_PACKAGE), { recursive: true });

  const binary = koffiBinaryInApp(appModules);
  if (!fs.existsSync(binary)) throw new Error(`koffi is in the app but its win32 binary is not: expected ${binary}`);
  const size = fs.statSync(binary).size;
  if (size < 100 * 1024) throw new Error(`koffi binary looks truncated: ${binary} is ${size} bytes`);
  console.log(`  koffi: ${koffiRoot}`);
  console.log(`  koffi binary: ${path.relative(OUT, binary)} (${(size / 1024).toFixed(0)} KB)`);
  return true;
}

console.log('copying koffi ...');
const koffiBundled = copyKoffi();

/**
 * Prove the copy actually loads inside the app, with the app's own Electron.  Reading
 * the files back would only show they were written; this is the property that matters,
 * and a build that ships a koffi nobody can load would look identical to the bug.
 */
function verifyKoffiInApp() {
  if (!koffiBundled) return 'skipped';
  const runner = path.join(APP, 'src', 'koffi-selftest.cjs');
  fs.writeFileSync(runner, [
    "'use strict';",
    "try {",
    "  const koffi = require('koffi');",
    "  const user32 = koffi.load('user32.dll');",
    "  const fn = user32.func('long GetWindowLongA(void *h, int i)');",
    "  console.log('koffi-in-app OK node=' + process.versions.node + ' electron=' + (process.versions.electron || '-') + ' fn=' + typeof fn);",
    "} catch (error) {",
    "  console.log('koffi-in-app FAILED: ' + error.message);",
    "}",
    '',
  ].join('\n'));
  try {
    const output = require('child_process').execFileSync(to, [runner], {
      cwd: APP,
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).trim();
    return output.includes('koffi-in-app OK') ? output.replace(/^koffi-in-app\s*/, '') : `FAILED (${output || 'no output'})`;
  } catch (error) {
    return `FAILED (${String(error.stderr || error.message).split('\n')[0]})`;
  } finally {
    fs.rmSync(runner, { force: true });
  }
}

const koffiStatus = verifyKoffiInApp();

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
console.log('koffi:', koffiStatus);
console.log('total size:', (sizeOf(OUT) / 1024 / 1024).toFixed(0), 'MB');
