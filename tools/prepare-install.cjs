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
// `electron.exe` alone is not proof that the distribution is complete: an extraction
// killed halfway (pnpm stops a whole process tree when an install fails) leaves the
// executable behind without the shared libraries and locale paks it needs, and npm
// will not run the postinstall again for a package it considers installed. A measured
// casualty of exactly that: a runtime with electron.exe but no ffmpeg.dll, which
// cannot start at all.
const REQUIRED_IN_DIST = [
  ...EXECUTABLE_NAMES,
  'ffmpeg.dll',
  'icudtl.dat',
  'resources.pak',
  'v8_context_snapshot.bin',
];

function runtimeIsBuilt() {
  return EXECUTABLE_NAMES.some((name) => fs.existsSync(path.join(RUNTIME, name)));
}

function electronIsDownloaded() {
  return REQUIRED_IN_DIST.every((name) => fs.existsSync(path.join(ELECTRON_DIST, name)));
}

/**
 * npm 11 blocks electron's postinstall, and an interrupted extraction is never
 * repaired by a later install. Removing the dist first makes the downloader redo the
 * whole extraction rather than accepting what is there.
 */
function downloadElectron() {
  const packageDir = path.join(ROOT, 'node_modules', 'electron');
  const installer = path.join(packageDir, 'install.js');
  if (!fs.existsSync(installer)) {
    throw new Error(
      'prepare: Electron is not installed at ' + packageDir + '\n'
      + '  Install dependencies first (`npm install` in a checkout), and if the download failed, retry with a mirror:\n'
      + '    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"; npm install',
    );
  }
  if (fs.existsSync(ELECTRON_DIST)) {
    const present = EXECUTABLE_NAMES.filter((name) => fs.existsSync(path.join(ELECTRON_DIST, name)));
    console.log(`prepare: Electron distribution is incomplete (${present.join(', ') || 'nothing'} present), re-downloading it ...`);
    fs.rmSync(ELECTRON_DIST, { recursive: true, force: true });
  } else {
    console.log('prepare: Electron binary missing (npm blocked its postinstall), downloading it ...');
  }
  execFileSync(process.execPath, [installer], {
    cwd: packageDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (!electronIsDownloaded()) {
    throw new Error(
      'prepare: Electron did not download completely; check the network or set a mirror:\n'
      + '  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"',
    );
  }
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
