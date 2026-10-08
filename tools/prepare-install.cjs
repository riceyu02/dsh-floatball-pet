'use strict';
/**
 * `prepare` hook.
 *
 * pnpm runs this script when the repository is installed as a git dependency —
 * `dsh plugin --profile desktop add git+https://github.com/riceyu02/dsh-desktop-pet.git`
 * is the one that matters here. The helper runtime is deliberately not committed (it
 * is a copy of the Electron distribution, roughly half a gigabyte), so it has to be
 * assembled on the machine doing the install. That is exactly what this does, into
 * `runtime/`, which `plugin/host.mjs` looks for first.
 *
 * Whether this is an install rather than a working copy is decided by `.git`: pnpm
 * fetches a git dependency as a tarball snapshot (no `.git` directory, and the
 * checkout lives in pnpm's own build directory, not under a `node_modules` path), so
 * a checkout keeps the fast path — `npm run pack` / `npm run build:dsh-plugin` do the
 * assembly on purpose there. The same applies to a source archive downloaded from
 * GitHub, which is also a "fetch it and run it" copy.
 *
 * One more thing an install has to survive: npm 11 blocks `postinstall` scripts by
 * default, so `node_modules/electron` can be present with no binary in it. The
 * official downloader is run in that case, honouring ELECTRON_MIRROR.
 *
 *   DSH_PET_PREPARE=1   force the assembly
 *   DSH_PET_PREPARE=0   skip it
 */
const { execFileSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const EXECUTABLE_NAMES = ['DSH悬浮球.exe', 'electron.exe', 'electron'];

function runtimeIsBuilt() {
  return EXECUTABLE_NAMES.some((name) => fs.existsSync(path.join(RUNTIME, name)));
}

function electronIsDownloaded() {
  return EXECUTABLE_NAMES.some((name) => fs.existsSync(path.join(ELECTRON_DIST, name)));
}

/** npm 11 blocks electron's postinstall; the package ships the same downloader. */
function downloadElectron() {
  const installer = path.join(ROOT, 'node_modules', 'electron', 'install.js');
  if (!fs.existsSync(installer)) {
    throw new Error(
      'prepare: Electron is not installed at ' + path.join(ROOT, 'node_modules', 'electron') + '\n'
      + '  Install dependencies first (`npm install` in a checkout), and if the download failed, retry with a mirror:\n'
      + '    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"; npm install',
    );
  }
  console.log('prepare: Electron binary missing (npm blocked its postinstall), downloading it ...');
  execFileSync(process.execPath, [installer], {
    cwd: path.join(ROOT, 'node_modules', 'electron'),
    stdio: 'inherit',
    env: process.env,
  });
}

function main() {
  const mode = process.env.DSH_PET_PREPARE;
  if (mode === '0') {
    console.log('prepare: skipped (DSH_PET_PREPARE=0)');
    return;
  }
  if (runtimeIsBuilt()) {
    console.log('prepare: runtime already assembled, nothing to do');
    return;
  }
  if (mode !== '1' && fs.existsSync(path.join(ROOT, '.git'))) {
    console.log('prepare: working copy, skipping the runtime assembly.');
    console.log('         run `npm run pack` (standalone app) or `npm run build:dsh-plugin` (installer) when you need it.');
    return;
  }

  console.log('prepare: assembling the helper runtime into runtime/ ...');
  if (!electronIsDownloaded()) downloadElectron();

  process.env.DSH_PET_ASSEMBLE_OUT = RUNTIME;
  require('./assemble.cjs');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
