'use strict';
/**
 * Check GitHub for a newer release, and hand the install back to DSH.
 *
 * Requests go through Electron's `net` rather than node's http: this is a normal
 * desktop process and Chromium picks up the machine's proxy settings, which is the
 * difference between working and timing out on networks where github.com is only
 * reachable through a proxy.
 *
 * Installing is deliberately a hand-off. pnpm cannot replace the package while the
 * ball is running — the helper executable lives inside the directory being replaced,
 * so the import fails with EPERM (measured). The pet therefore downloads the release
 * tarball, writes a small detached script that waits for this process to exit and then
 * runs the DSH CLI, and quits. DSH needs a restart afterwards: its plugin manager
 * reports `restart-required` for a package replacement, because a fresh JavaScript
 * module generation cannot be loaded into the running process.
 */
const { net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = 'riceyu02/dsh-floatball-pet';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const REQUEST_TIMEOUT_MS = 20000;
/** Installers to keep: the installed version plus the one before it (offline rollback). */
const KEEP_INSTALLERS = 2;

/** The version this build carries: the manifest packed beside the app. */
function currentVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return manifest.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Compare dotted versions. Returns 1 when `a` is newer, -1 when `b` is, 0 when equal. */
function compareVersions(a, b) {
  const left = String(a).replace(/^v/, '').split('.');
  const right = String(b).replace(/^v/, '').split('.');
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = Number.parseInt(left[index] || '0', 10) || 0;
    const r = Number.parseInt(right[index] || '0', 10) || 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

/** `<profile>` for the running install, from the environment the host handed us. */
function profileDir(env = process.env) {
  if (env.DSH_PROFILE_DIR) return env.DSH_PROFILE_DIR;
  if (env.DSH_PET_USER_DATA) return path.dirname(path.dirname(env.DSH_PET_USER_DATA));
  return null;
}

function pluginTarballDir(env = process.env) {
  const profile = profileDir(env);
  return profile ? path.join(profile, 'plugin-tarballs') : null;
}

/** The CLI that installs plugins, derived from the running DSH executable. */
function cliPath(dshExePath) {
  const candidates = [
    dshExePath,
    process.env.DSH_DESKTOP_EXE,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(process.env.ProgramFiles || '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const cli = path.join(path.dirname(candidate), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    if (fs.existsSync(cli)) return cli;
  }
  return null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow' });
    request.setHeader('Accept', 'application/vnd.github+json');
    request.setHeader('User-Agent', `dsh-floatball-pet${currentVersion()}`);
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error('请求超时（20 秒）'));
    }, REQUEST_TIMEOUT_MS);
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub 返回 HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`返回内容不是 JSON：${error.message}`));
        }
      });
      response.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

/**
 * Ask GitHub for the latest release and compare it with this build.
 * @returns {Promise<object>} current/latest versions, whether a newer one exists, and
 *   the tarball asset to fetch.
 */
async function checkLatest() {
  const current = currentVersion();
  const release = await getJson(API_LATEST);
  const latest = String(release.tag_name || '').replace(/^v/, '');
  const asset = (release.assets || []).find((entry) => /\.tgz$/i.test(entry.name || ''));
  return {
    current,
    latest,
    newer: Boolean(latest) && compareVersions(latest, current) > 0,
    publishedAt: release.published_at || null,
    pageUrl: release.html_url || `https://github.com/${REPO}/releases`,
    assetName: asset ? asset.name : null,
    assetUrl: asset ? asset.browser_download_url : null,
    assetSize: asset ? asset.size : null,
  };
}

function download(url, destination, onProgress) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow' });
    request.setHeader('User-Agent', `dsh-floatball-pet${currentVersion()}`);
    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`下载失败：HTTP ${response.statusCode}`));
        return;
      }
      const total = Number(response.headers['content-length'] || 0);
      const out = fs.createWriteStream(destination);
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        out.write(chunk);
        if (onProgress) onProgress(received, total);
      });
      response.on('end', () => out.end(() => resolve({ bytes: received, total })));
      response.on('error', (error) => {
        out.destroy();
        reject(error);
      });
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * The detached installer. Written as a file because it has to outlive the pet: it waits
 * for everything running out of the package to exit (that is what releases the file
 * locks pnpm needs) and then runs the DSH CLI, recording the outcome where the next
 * start can read it.
 *
 * Three lessons from a tester's failed 0.2.6 → 0.2.7 run, which left the profile in a
 * state DSH could not even boot from:
 *
 *  1. Waiting for the pet's pid alone is not enough. The focus helper is a *detached*
 *     process running the package's own `runtime\DSH悬浮球.exe` (as Node), and it
 *     outlives the pet by design — so `runtime\` stayed locked and pnpm's importPackage
 *     failed with EPERM. What matters is "no process is running out of this package",
 *     which is what this enumerates.
 *  2. Running out of time must ABORT. The old script fell through its wait loop and
 *     installed anyway, which is the one case where EPERM is guaranteed.
 *  3. A failed import leaves the package gutted (only `runtime\` left), plus an orphan
 *     `<name>_tmp_*` directory and a manifest/lockfile pair that disagree — DSH then
 *     cannot resolve the bundle. So verify the result, clean up and try once more, and
 *     always record the recovery commands.
 */
/**
 * The names this package can be installed under. A profile installed from a `file:` or
 * from npm uses the scoped name; the release tarballs do not, and neither do profiles
 * installed before the scope existed. Every lookup below accepts either, or an older
 * installation silently loses its cleanup and rollback paths.
 */
const PACKAGE_NAMES = ['dsh-floatball-pet', 'dsh-desktop-pet'];

/** The profile manifest's spec for this package, whichever name it was installed under. */
function selfSpec(manifest) {
  for (const name of PACKAGE_NAMES) {
    const spec = manifest && manifest.dependencies && manifest.dependencies[name];
    if (typeof spec === 'string') return spec;
  }
  return null;
}

/** `[whole, prefix]` of a tarball of this package, for either naming scheme. */
function tarballMatch(name) {
  return /^((?:dsh-floatball-pet|dsh-desktop-pet))-[0-9]+\.[0-9]+\.[0-9]+\.tgz$/.exec(name);
}

function tarballIsOurs(name) {
  return tarballMatch(name) !== null;
}

function tarballVersion(name) {
  const match = tarballMatch(name);
  return match === null ? null : name.slice(match[1].length + 1, -'.tgz'.length);
}
const APPLY_SCRIPT = [
  "'use strict';",
  "const { spawnSync } = require('node:child_process');",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
  "const PACKAGE_NAMES = config.packageNames || [];",
  "const TARBALL_NAME = /^((?:dsh-floatball-pet|dsh-desktop-pet))-[0-9]+[.][0-9]+[.][0-9]+[.]tgz$/;",
  "/** This package's spec in the profile manifest, whichever name it was installed under. */",
  "function specOf(manifest) {",
  "  for (const name of PACKAGE_NAMES) {",
  "    const spec = manifest.dependencies && manifest.dependencies[name];",
  "    if (typeof spec === 'string') return spec;",
  "  }",
  "  return null;",
  "}",
  "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
  "const write = (payload) => fs.writeFileSync(config.statusPath, JSON.stringify(payload, null, 2));",
  "",
  "/** Ids of every process whose executable lives inside the package we replace. */",
  "function processesInPackage() {",
  "  const script = \"Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('\" + config.packageDir + \"', 'OrdinalIgnoreCase') } | ForEach-Object { $_.Id }\";",
  "  const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });",
  "  return (probe.stdout || '').split(/\\s+/).filter(Boolean).map(Number).filter((id) => id > 0);",
  "}",
  "",
  "function install() {",
  "  return spawnSync('cmd.exe', ['/c', config.cli, 'plugin', '--profile', config.profile, 'add', config.tgz], { encoding: 'utf8', windowsHide: true });",
  "}",
  "",
  "/** DSH resolves the bundle out of these three things; without them it will not boot. */",
  "function packageIntact() {",
  "  try {",
  "    const manifest = JSON.parse(fs.readFileSync(path.join(config.packageDir, 'package.json'), 'utf8'));",
  "    const patch = manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch;",
  "    if (!patch) return false;",
  "    return fs.existsSync(path.join(config.packageDir, 'cordis.patch.yml'))",
  "      && fs.existsSync(path.join(config.packageDir, 'plugin', 'host.mjs'));",
  "  } catch {",
  "    return false;",
  "  }",
  "}",
  "",
  "/**",
  " * Delete the installers of versions we have moved past (113 MB each).",
  " * The file the profile manifest now points at is never touched — removing that would",
  " * break the next `pnpm install` — and neither are the newest couple, which are the",
  " * offline rollback. If the manifest cannot be read, nothing is deleted at all.",
  " */",
  "function cleanOldInstalls() {",
  "  const dir = config.tarballDir;",
  "  const removed = [];",
  "  try {",
  "    if (!dir || !fs.existsSync(dir)) return removed;",
  "    const manifest = JSON.parse(fs.readFileSync(path.join(config.profileDir, 'package.json'), 'utf8'));",
  "    const spec = selfSpec(manifest);",
  "    if (typeof spec !== 'string' || !spec.startsWith('file:')) return removed;",
  "    const protectedPaths = [path.resolve(config.profileDir, spec.slice('file:'.length))];",
  "    const names = fs.readdirSync(dir).map((name) => {",
  "      const match = name.match(TARBALL_NAME);",
  "      return match ? { name, version: name.slice(match[1].length + 1, -4) } : null;",
  "    }).filter(Boolean).map((entry) => entry.name)",
  "      .sort((a, b) => {",
  "        const match = (n) => n.match(TARBALL_NAME);",
  "        const left = a.slice(match(a)[1].length + 1, -4).split('.').map(Number);",
  "        const right = b.slice(match(b)[1].length + 1, -4).split('.').map(Number);",
  "        for (let i = 0; i < 3; i += 1) {",
  "          if ((left[i] || 0) !== (right[i] || 0)) return (right[i] || 0) - (left[i] || 0);",
  "        }",
  "        return 0;",
  "      });",
  "    for (const name of names.slice(0, config.keepInstallers || 2)) protectedPaths.push(path.resolve(dir, name));",
  "    for (const name of names) {",
  "      const full = path.resolve(dir, name);",
  "      if (protectedPaths.includes(full)) continue;",
  "      try { fs.rmSync(full, { force: true }); removed.push(name); } catch { }",
  "    }",
  "    for (const name of fs.readdirSync(dir)) {",
  "      const isOurs = TARBALL_NAME.test(name);",
  "      if (isOurs && name.endsWith('.part')) {",
  "        try { fs.rmSync(path.join(dir, name), { force: true }); removed.push(name); } catch { }",
  "      }",
  "    }",
  "  } catch { }",
  "  return removed;",
  "}",
  "",
  "function cleanUp() {",
  "  for (const pid of processesInPackage()) { try { process.kill(pid); } catch { } }",
  "  try { fs.rmSync(config.packageDir, { recursive: true, force: true }); } catch { }",
  "  try {",
  "    const prefix = path.basename(config.packageDir) + '_tmp_';",
  "    for (const entry of fs.readdirSync(config.nodeModulesDir)) {",
  "      if (entry.startsWith(prefix)) {",
  "        try { fs.rmSync(path.join(config.nodeModulesDir, entry), { recursive: true, force: true }); } catch { }",
  "      }",
  "    }",
  "  } catch { }",
  "}",
  "",
  "(async () => {",
  "  const deadline = Date.now() + 45000;",
  "  let alive = processesInPackage();",
  "  while (alive.length && Date.now() < deadline) {",
  "    await sleep(500);",
  "    alive = processesInPackage();",
  "  }",
  "  if (alive.length) {",
  "    write({",
  "      at: Date.now(),",
  "      version: config.version,",
  "      ok: false,",
  "      reason: 'helper-running',",
  "      pids: alive,",
  "      recovery: config.recovery,",
  "    });",
  "    return;",
  "  }",
  "",
  "  let result = install();",
  "  if (result.status !== 0 || !packageIntact()) {",
  "    await sleep(800);",
  "    cleanUp();",
  "    await sleep(800);",
  "    result = install();",
  "  }",
  "",
  "  const ok = result.status === 0 && packageIntact();",
  "  // Past versions are dead weight — 113 MB each, sitting in the profile people back",
  "  // up. Only after a verified install, only files named after this package, and never",
  "  // the one the manifest now points at (see cleanOldInstalls).",
  "  const removed = ok ? cleanOldInstalls() : [];",
  "  write({",
  "    at: Date.now(),",
  "    version: config.version,",
  "    ok,",
  "    code: result.status,",
  "    reason: ok ? null : (packageIntact() ? 'install-failed' : 'package-incomplete'),",
  "    recovery: ok ? null : config.recovery,",
  "    removed,",
  "    output: ((result.stdout || '') + (result.stderr || '')).slice(-4000),",
  "  });",
  "})();",
  "",
].join('\n');

/**
 * Download the release tarball into the profile and schedule its installation.
 * @param {object} release - the object returned by checkLatest.
 * @param {string} dshExePath - path of the running DSH executable, used to find its CLI.
 * @param {(received:number,total:number)=>void} [onProgress]
 * @returns {Promise<{version:string, tarball:string}>}
 */
async function stageAndApply(release, dshExePath, onProgress) {
  if (!release || !release.assetUrl || !release.assetName) {
    throw new Error('这个 Release 没有可用的 .tgz 附件');
  }
  const tarballDir = pluginTarballDir();
  if (!tarballDir) throw new Error('拿不到 profile 目录（缺少 DSH_PROFILE_DIR / DSH_PET_USER_DATA）');
  const cli = cliPath(dshExePath);
  if (!cli) throw new Error('找不到 DSH 的 CLI，无法自动安装');

  const target = path.join(tarballDir, release.assetName);
  const partial = `${target}.part`;
  fs.mkdirSync(tarballDir, { recursive: true });
  if (!fs.existsSync(target)) {
    await download(release.assetUrl, partial, onProgress);
    fs.renameSync(partial, target);
  }

  const userData = process.env.DSH_PET_USER_DATA || path.dirname(target);
  const configPath = path.join(userData, 'apply-update.json');
  const statusPath = path.join(userData, 'update-status.json');
  const profile = path.basename(profileDir());
  const nodeModulesDir = path.join(profileDir(), 'node_modules');
  const packageDir = path.join(nodeModulesDir, 'dsh-floatball-pet');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    pid: process.pid,
    cli,
    profile,
    tgz: target,
    version: release.latest,
    statusPath,
    nodeModulesDir,
    packageDir,
    tarballDir,
    profileDir: profileDir(),
    keepInstallers: KEEP_INSTALLERS,
    packageNames: PACKAGE_NAMES,
    recovery: [
      '① 确认没有 DSH悬浮球 进程在跑（托盘退出不够，焦点帮手是独立进程）',
      `② 删除 ${packageDir} 与 ${nodeModulesDir}\\dsh-floatball-pet_tmp_*`,
      `③ 重新安装：dsh plugin --profile ${profile} add "${target}"`,
    ].join('\n'),
  }, null, 2));
  const scriptPath = path.join(userData, 'apply-update.cjs');
  fs.writeFileSync(scriptPath, APPLY_SCRIPT);

  // Same trick the focus helper uses: this executable is the one guaranteed Node
  // runtime on the machine, and ELECTRON_RUN_AS_NODE makes it behave as one.
  const child = spawn(process.execPath, [scriptPath, configPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  return { version: release.latest, tarball: target, statusPath };
}

/** What the detached installer recorded last time, if anything. */
function lastResult(env = process.env) {
  const userData = env.DSH_PET_USER_DATA;
  if (!userData) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, 'update-status.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** The tarball the profile manifest points at right now. */
function installedTarball(env = process.env) {
  const profile = profileDir(env);
  if (!profile) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
    const spec = selfSpec(manifest);
    if (typeof spec !== 'string' || !spec.startsWith('file:')) return null;
    return path.resolve(profile, spec.slice('file:'.length));
  } catch {
    return null;
  }
}

/**
 * Delete the installers of versions we have moved past.
 *
 * Each one is a whole Electron runtime (113 MB), so a handful of updates leaves a
 * gigabyte of dead weight in the profile — and the profile is the thing people back up.
 *
 * Safety rules, in order of importance:
 *   * only files named after this package are considered at all;
 *   * the tarball the profile manifest currently points at is never removed — deleting
 *     that breaks the next `pnpm install` outright;
 *   * when the manifest cannot be read, nothing is deleted;
 *   * the newest `keep` files stay, because the one before the current version is the
 *     offline rollback.
 *
 * @returns {{removed: string[], kept: string[]}} file names, for the log and the panel.
 */
function cleanupOldTarballs({ keep = KEEP_INSTALLERS, env = process.env } = {}) {
  const directory = pluginTarballDir(env);
  const profile = profileDir(env);
  const nothing = { removed: [], kept: [] };
  if (!directory || !profile || !fs.existsSync(directory)) return nothing;
  if (!installedTarball(env)) return nothing; // no readable manifest: leave it alone

  const protectedPaths = new Set([path.resolve(installedTarball(env))]);
  const ours = fs.readdirSync(directory)
    .filter((name) => tarballIsOurs(name))
    .map((name) => ({
      name,
      full: path.join(directory, name),
      version: tarballVersion(name),
    }))
    .sort((a, b) => compareVersions(b.version, a.version)); // newest first

  for (const entry of ours.slice(0, keep)) protectedPaths.add(path.resolve(entry.full));

  const removed = [];
  for (const entry of ours) {
    if (protectedPaths.has(path.resolve(entry.full))) continue;
    try {
      fs.rmSync(entry.full, { force: true });
      removed.push(entry.name);
    } catch {
      // Locked or gone: not worth failing an update over.
    }
  }
  // Half-downloaded files from an interrupted update.
  for (const name of fs.readdirSync(directory)) {
    if (tarballIsOurs(name) && name.endsWith('.part')) {
      try {
        fs.rmSync(path.join(directory, name), { force: true });
        removed.push(name);
      } catch { /* ignore */ }
    }
  }
  return { removed, kept: ours.filter((e) => protectedPaths.has(path.resolve(e.full))).map((e) => e.name) };
}

module.exports = {
  currentVersion,
  compareVersions,
  checkLatest,
  stageAndApply,
  lastResult,
  cleanupOldTarballs,
  profileDir,
};
