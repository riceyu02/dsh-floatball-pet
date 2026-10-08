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

const REPO = 'riceyu02/dsh-desktop-pet';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const REQUEST_TIMEOUT_MS = 20000;

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
    request.setHeader('User-Agent', `dsh-desktop-pet/${currentVersion()}`);
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
    request.setHeader('User-Agent', `dsh-desktop-pet/${currentVersion()}`);
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
 * The detached installer. Written as a file because it has to outlive this process:
 * it waits for the pet to exit (that is what releases the file locks pnpm needs) and
 * then runs the DSH CLI, recording the outcome where the next start can read it.
 */
const APPLY_SCRIPT = `'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (payload) => fs.writeFileSync(config.statusPath, JSON.stringify(payload, null, 2));

(async () => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { process.kill(config.pid, 0); } catch { break; }
    await sleep(400);
  }
  const result = spawnSync('cmd.exe', ['/c', config.cli, 'plugin', '--profile', config.profile, 'add', config.tgz], {
    encoding: 'utf8',
    windowsHide: true,
  });
  write({
    at: Date.now(),
    version: config.version,
    ok: result.status === 0,
    code: result.status,
    output: ((result.stdout || '') + (result.stderr || '')).slice(-4000),
  });
})();
`;

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
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    pid: process.pid,
    cli,
    profile: path.basename(profileDir()),
    tgz: target,
    version: release.latest,
    statusPath,
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

module.exports = { currentVersion, compareVersions, checkLatest, stageAndApply, lastResult, profileDir };
