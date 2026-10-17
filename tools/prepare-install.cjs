'use strict';
/**
 * `prepare` + `postinstall` hook.
 *
 * Two hook names because npm runs different ones for different sources, and both are
 * routes this package is installed by:
 *
 *   prepare      a git dependency (`dsh plugin ... add git+https://github.com/...`) —
 *                pnpm/npm build the fetched tree and run `prepare` there
 *   postinstall  the published registry tarball (`dsh plugin ... add dsh-floatball-pet`) —
 *                `prepare` does NOT run for a registry install, so without this hook the
 *                package would land with no runtime and the ball would refuse to start
 *
 * The helper runtime is deliberately not published (it is a copy of the Electron
 * distribution, a quarter of a gigabyte), so it has to be assembled on the machine doing
 * the install. Both hooks share this file and both are idempotent: the package-local
 * `runtime/` (the all-in-one tarball) and the version-keyed cache are checked first.
 *
 * Where it lands is the point of this file: **a stable directory under `$DSH_HOME`, not
 * inside the package**. `node_modules/dsh-desktop-pet` is deleted and recreated on every
 * plugin upgrade, so a runtime kept there is rebuilt every time — and its file locks are
 * what make pnpm report `ERR_PNPM_EPERM ... runtime` while the ball is running. The cache
 * is keyed by Electron version alone, so:
 *
 *   first install      download Electron once, verify it, extract, assemble
 *   plugin upgrade     nothing to do — the cache already holds the runtime
 *   Electron upgrade   download the new one into its own versioned directory
 *
 * A runtime that shipped inside the package is still looked up first by
 * `plugin/host.mjs`, so an install that already carries one keeps using it and this
 * script has nothing to assemble.
 *
 * Whether this is an install rather than a working copy is decided by `.git`: pnpm
 * fetches a git dependency as a tarball snapshot (no `.git` directory, and the checkout
 * lives in pnpm's own build directory), so a checkout keeps the fast path —
 * `npm run pack` / `npm run build:dsh-plugin` assemble on purpose there. The same
 * applies to a source archive downloaded from GitHub, which is also a fetch-and-run copy.
 *
 * One more thing an install has to survive: npm 11 blocks `postinstall` scripts by
 * default, so `node_modules/electron` can be present with no binary in it. The official
 * downloader is run in that case, honouring ELECTRON_MIRROR.
 *
 *   DSH_PET_PREPARE=0        skip this script entirely
 *   DSH_PET_PREPARE=1        assemble even in a working copy
 *   DSH_PET_RUNTIME_DIR      use this directory instead of the versioned cache
 *   DSH_PET_HOME             override `$DSH_HOME` when locating the cache
 *   DSH_PET_ELECTRON_MIRROR  download base URL, `{version}` placeholder
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const ELECTRON_PACKAGE = path.join(ROOT, 'node_modules', 'electron', 'package.json');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const EXECUTABLE_NAMES = ['DSH\u60ac\u6d6e\u7403.exe', 'electron.exe', 'electron'];
// `electron.exe` alone is not proof that the distribution is complete: an extraction
// killed halfway (pnpm stops a whole process tree when an install fails) leaves the
// executable behind without the shared libraries and locale paks it needs, and npm will
// not run the postinstall again for a package it considers installed. A measured
// casualty of exactly that: a runtime with electron.exe but no ffmpeg.dll, which cannot
// start at all.
//
// Kept separate from the launcher name on purpose: assembly RENAMES `electron.exe` into
// `DSH悬浮球.exe`, so a check that demands `electron.exe` of an assembled directory fails
// on a runtime that is perfectly fine. Both halves of that mistake were measured against
// real downloads.
const REQUIRED_RUNTIME_FILES = ['ffmpeg.dll', 'icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin'];
/** What a freshly extracted release holds: the launcher under Electron's own name. */
const REQUIRED_IN_DIST = ['electron.exe', ...REQUIRED_RUNTIME_FILES];
/**
 * Download bases, tried in order. npmmirror goes first on purpose: github.com is
 * unreachable for much of this plugin's audience, and a dropped connection there would
 * otherwise stall an install. Every download is verified against the release's own
 * SHASUMS256.txt, so trying a mirror first costs no trust — a mirror serving anything
 * else is rejected and the next source is asked. Measured: all three sources below
 * report the same SHA-256 for the win32-x64 zip.
 */
const MIRROR_TEMPLATE = process.env.DSH_PET_ELECTRON_MIRROR
  || 'https://cdn.npmmirror.com/binaries/electron/v{version}';
const GITHUB_TEMPLATE = 'https://github.com/electron/electron/releases/download/v{version}';

/** Every line this script prints carries one prefix, so an install log reads as a block. */
function log(message) {
  console.log(`prepare: ${message}`);
}

/** A runtime directory is complete when it has a launcher (either name — `electron.exe`
 * is renamed to the branded one during assembly) plus Electron's own support files.
 * Checking only for the executable is not enough: an extraction killed halfway leaves
 * the executable behind without the shared libraries, and such a runtime cannot start. */
function runtimeIsBuilt(dir = RUNTIME) {
  const executable = EXECUTABLE_NAMES.some((name) => fs.existsSync(path.join(dir, name)));
  return executable && REQUIRED_RUNTIME_FILES.every((name) => fs.existsSync(path.join(dir, name)));
}

function electronIsDownloaded() {
  return REQUIRED_IN_DIST.every((name) => fs.existsSync(path.join(ELECTRON_DIST, name)));
}

/** The Electron release to use, read from the installed package when there is one. */
function electronVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(ELECTRON_PACKAGE, 'utf8'));
    if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version;
  } catch { /* not installed yet, or unreadable: the declared range below is the best guess */ }
  const declared = require(path.join(ROOT, 'package.json')).devDependencies.electron;
  const exact = /^\d+\.\d+\.\d+/.exec(declared);
  return exact === null ? declared.replace(/^[\^~]/, '') : exact[0];
}

/** `$DSH_HOME`, or `~/.dsh` when a plain terminal install hands us no `DSH_*` at all.
 * Mirrors `resolveDshHome` in `plugin/host.mjs`, so both halves agree on one path. */
function dshHome(env = process.env) {
  if (env.DSH_PET_HOME) return path.resolve(env.DSH_PET_HOME);
  if (env.DSH_HOME) return path.resolve(env.DSH_HOME);
  return path.join(os.homedir(), '.dsh');
}

/** The stable runtime directory for an Electron version: assembled once, reused by every
 * later plugin version. `DSH_PET_RUNTIME_DIR` overrides it outright, which is what a test
 * uses to keep its downloads out of a real profile. */
function cachedRuntimeDir(version) {
  if (process.env.DSH_PET_RUNTIME_DIR) return path.resolve(process.env.DSH_PET_RUNTIME_DIR);
  return path.join(dshHome(), 'dsh-desktop-pet', 'runtime', version);
}

/** Marker written last, so a half-finished assembly is never taken for a complete one. */
function markerPath(dir) {
  return path.join(dir, '.ready.json');
}

function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(dir, fields) {
  fs.writeFileSync(markerPath(dir), `${JSON.stringify({ ...fields, completedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** Whether the cache already holds a usable runtime for this Electron version. The marker
 * is what makes this an answer rather than a guess: a directory without one is a leftover
 * from an interrupted run, and gets rebuilt. */
function cachedRuntimeIsReady(dir, version) {
  const marker = readMarker(dir);
  return marker !== null
    && marker.electronVersion === version
    && typeof marker.source === 'string'
    && runtimeIsBuilt(dir);
}

function sha256(file) {
  const { createHash } = require('node:crypto');
  const hash = createHash('sha256');
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let read;
    do {
      read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (read > 0) hash.update(buffer.subarray(0, read));
    } while (read > 0);
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

/** Proxy-aware and present on every Windows 10+ install. `--ssl-no-revoke` because an
 * unreachable revocation endpoint otherwise aborts the transfer, which is common behind
 * a proxy; every download is checksum-verified anyway. */
function curlBinary() {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
  return fs.existsSync(system) ? system : 'curl.exe';
}

function curl(args, options = {}) {
  return execFileSync(curlBinary(), [
    '--fail', '--location', '--silent', '--show-error', '--ssl-no-revoke',
    '--connect-timeout', '15', '--retry', '2', '--retry-delay', '2',
    ...args,
  ], { stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' });
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** Download the release zip from the first source whose bytes match the checksum that
 * release publishes. Returns the verified archive path. */
function downloadZip(version, destination) {
  const zipName = `electron-v${version}-win32-x64.zip`;
  const sources = [MIRROR_TEMPLATE, GITHUB_TEMPLATE].filter((value, index, all) => all.indexOf(value) === index);
  const failures = [];
  let expected = null;
  let checksumFrom = null;

  for (const template of sources) {
    const base = template.replace('{version}', version);
    let host = template;
    try { host = new URL(`${base}/`).host; } catch { /* keep the template as the label */ }
    try {
      for (const line of curl([`${base}/SHASUMS256.txt`], { capture: true }).split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[parts.length - 1].replace(/^\*/, '') === zipName) {
          expected = parts[0].toLowerCase();
          checksumFrom = host;
          break;
        }
      }
      if (expected !== null) break;
      failures.push(`${host}: ${zipName} is not listed in SHASUMS256.txt`);
    } catch (error) {
      failures.push(`${host}: ${String(error.message).split('\n')[0]}`);
    }
  }

  if (expected === null) {
    throw new Error(`could not obtain a checksum for ${zipName}\n  ${failures.join('\n  ')}`);
  }
  log(`electron ${version} checksum from ${checksumFrom}: ${expected.slice(0, 16)}...`);

  for (const template of sources) {
    const url = `${template.replace('{version}', version)}/${zipName}`;
    const started = Date.now();
    try {
      log(`downloading ${url}`);
      curl(['--output', destination, url]);
      const bytes = fileSize(destination);
      const actual = sha256(destination);
      if (actual !== expected) throw new Error(`checksum mismatch: expected ${expected}, got ${actual}`);
      const seconds = Math.max(0.1, (Date.now() - started) / 1000);
      log(`downloaded ${(bytes / 1024 / 1024).toFixed(1)} MB in ${seconds.toFixed(1)}s `
        + `(${(bytes / 1024 / 1024 / seconds).toFixed(1)} MB/s), sha256 verified`);
      return { path: destination, sha256: actual, bytes, source: new URL(url).host };
    } catch (error) {
      failures.push(`${url}: ${String(error.message).split('\n')[0]}`);
      try { fs.rmSync(destination, { force: true }); } catch { /* nothing to clean up */ }
    }
  }

  throw new Error(`every download source failed for ${zipName}\n  ${failures.join('\n  ')}`);
}

/** `tar.exe` reads zip on Windows 10+; PowerShell is the fallback. */
function extractZip(zipPath, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(tar)) {
    execFileSync(tar, ['-xf', zipPath, '-C', destination], { stdio: 'inherit' });
    return;
  }
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destination}" -Force`,
  ], { stdio: 'inherit' });
}

/** Assemble into `out` from a chosen Electron distribution, then mark it complete. */
function assembleInto(out, version, source, distribution) {
  process.env.DSH_PET_ASSEMBLE_OUT = out;
  // The published package already carries build/PetFocus.dll. Rebuilding it here would
  // spawn PowerShell's Add-Type, which is exactly what this DLL exists to avoid on the
  // machines that install the plugin — an install must not depend on a working C#
  // compiler. Release builds (build-dsh-plugin) leave this unset and do rebuild it.
  process.env.DSH_PET_FOCUS_DLL = 'reuse';
  if (distribution !== undefined) process.env.DSH_PET_ELECTRON_DIST = distribution;
  try {
    require('./assemble.cjs');
  } finally {
    delete process.env.DSH_PET_ASSEMBLE_OUT;
    delete process.env.DSH_PET_ELECTRON_DIST;
    delete process.env.DSH_PET_FOCUS_DLL;
  }
  // The assembled directory is checked the same way as any other runtime; this is where
  // an assembly that silently copied nothing gets caught.
  if (!runtimeIsBuilt(out)) throw new Error(`assembly produced no usable runtime in ${out}`);
  writeMarker(out, { electronVersion: version, source });
  fs.writeFileSync(path.join(out, 'electron-version.txt'), `${version}\n`);
}

/** Build the cached runtime from the verified release zip. This is the path a published
 * (runtime-less) tarball takes, and the only one that needs the network at all. */
function assembleFromRelease(version, out) {
  const downloads = path.join(dshHome(), 'dsh-desktop-pet', 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const zipPath = path.join(downloads, `electron-v${version}-win32-x64.zip`);
  const unpacked = path.join(downloads, `electron-v${version}-win32-x64`);

  const verified = downloadZip(version, zipPath);
  if (!REQUIRED_IN_DIST.every((name) => fs.existsSync(path.join(unpacked, name)))) {
    log('extracting the Electron release ...');
    extractZip(verified.path, unpacked);
  }
  const missing = REQUIRED_IN_DIST.filter((name) => !fs.existsSync(path.join(unpacked, name)));
  if (missing.length > 0) throw new Error(`extracted release is incomplete, missing ${missing.join(', ')}`);
  assembleInto(out, version, `${verified.source} ${verified.sha256.slice(0, 16)}...`, unpacked);
}

/**
 * npm 11 blocks electron's postinstall, and an interrupted extraction is never repaired
 * by a later install. Removing the dist first makes the downloader redo the whole
 * extraction rather than accepting what is there.
 */
function downloadElectron() {
  const packageDir = path.join(ROOT, 'node_modules', 'electron');
  const installer = path.join(packageDir, 'install.js');
  if (!fs.existsSync(installer)) {
    throw new Error(
      'Electron is not installed at ' + packageDir + '\n'
      + '  Install dependencies first (`npm install` in a checkout); if the download failed, retry with a mirror:\n'
      + '    $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"; npm install',
    );
  }
  if (fs.existsSync(ELECTRON_DIST)) {
    const present = EXECUTABLE_NAMES.filter((name) => fs.existsSync(path.join(ELECTRON_DIST, name)));
    log(`Electron distribution is incomplete (${present.join(', ') || 'nothing'} present), re-downloading it ...`);
    fs.rmSync(ELECTRON_DIST, { recursive: true, force: true });
  } else {
    log('Electron binary missing (npm blocked its postinstall), downloading it ...');
  }
  execFileSync(process.execPath, [installer], { cwd: packageDir, stdio: 'inherit', env: process.env });
  if (!electronIsDownloaded()) {
    throw new Error(
      'Electron did not download completely; check the network or set a mirror:\n'
      + '  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"',
    );
  }
}

function main() {
  const mode = process.env.DSH_PET_PREPARE;
  if (mode === '0') {
    log('skipped (DSH_PET_PREPARE=0)');
    return;
  }

  const version = electronVersion();
  const cacheDir = cachedRuntimeDir(version);

  // 1. A runtime that came with the package (the all-in-one tarball) wins; there is then
  //    nothing to download and nothing to assemble.
  if (runtimeIsBuilt(RUNTIME)) {
    log(`runtime already present at ${RUNTIME}, nothing to do`);
    return;
  }

  // 2. The stable cache — this is the upgrade path. A hit means no download and no
  //    assembly, which is the whole reason the cache lives outside the package.
  if (cachedRuntimeIsReady(cacheDir, version)) {
    log(`runtime cache hit for Electron ${version}: ${cacheDir}`);
    return;
  }

  if (mode !== '1' && fs.existsSync(path.join(ROOT, '.git'))) {
    log('working copy, skipping the runtime assembly.');
    log('         run `npm run pack` (standalone app) or `npm run build:dsh-plugin` (installer) when you need it.');
    return;
  }

  // 3. A checkout that already downloaded Electron assembles from it: local, offline, and
  //    needing no checksum because those bytes arrived through npm.
  if (!electronIsDownloaded() && fs.existsSync(path.join(ROOT, 'node_modules', 'electron'))) downloadElectron();
  if (electronIsDownloaded()) {
    log(`assembling the helper runtime for Electron ${version} into ${cacheDir} ...`);
    fs.mkdirSync(cacheDir, { recursive: true });
    assembleInto(cacheDir, version, 'node_modules/electron/dist');
    return;
  }

  // 4. Nothing local to copy: fetch the verified release zip.
  log(`assembling the helper runtime for Electron ${version} into ${cacheDir} ...`);
  fs.mkdirSync(cacheDir, { recursive: true });
  assembleFromRelease(version, cacheDir);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}