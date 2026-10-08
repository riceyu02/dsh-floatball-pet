'use strict';
/**
 * `prepare` hook.
 *
 * pnpm runs this script when the repository is installed as a git dependency —
 * `dsh plugin --profile desktop add github:riceyu02/dsh-desktop-pet` is the one that
 * matters here. The helper runtime is deliberately not committed (it is a copy of the
 * Electron distribution, roughly half a gigabyte), so it has to be assembled on the
 * machine doing the install. That is exactly what this does, into `runtime/`, which
 * `plugin/host.mjs` looks for first.
 *
 * A plain `npm install` inside a checkout triggers `prepare` as well, but there the
 * assembly is wasted work — `npm run pack` / `npm run build:dsh-plugin` do it on
 * purpose, when the runtime is actually needed — so the checkout case is skipped.
 * The two are told apart by location: a git dependency is unpacked inside a
 * `node_modules` directory, a working copy is not.
 *
 *   DSH_PET_PREPARE=1   force the assembly
 *   DSH_PET_PREPARE=0   skip it
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const EXECUTABLE = path.join(RUNTIME, 'DSH悬浮球.exe');

function isInstalledPackage() {
  return ROOT.split(/[\\/]/).includes('node_modules');
}

function main() {
  const mode = process.env.DSH_PET_PREPARE;
  if (mode === '0') {
    console.log('prepare: skipped (DSH_PET_PREPARE=0)');
    return;
  }
  if (fs.existsSync(EXECUTABLE) || fs.existsSync(path.join(RUNTIME, 'electron.exe'))) {
    console.log('prepare: runtime already assembled, nothing to do');
    return;
  }
  if (mode !== '1' && !isInstalledPackage()) {
    console.log('prepare: working copy, skipping the runtime assembly.');
    console.log('         run `npm run pack` (standalone app) or `npm run build:dsh-plugin` (installer) when you need it.');
    return;
  }

  const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(electronDist)) {
    throw new Error(
      'prepare: the Electron runtime is missing at ' + electronDist + '\n'
      + '  Install dependencies first (`npm install`), and if that download failed, retry it with a mirror:\n'
      + '    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"; npm install',
    );
  }

  console.log('prepare: assembling the helper runtime into runtime/ ...');
  process.env.DSH_PET_ASSEMBLE_OUT = RUNTIME;
  require('./assemble.cjs');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
