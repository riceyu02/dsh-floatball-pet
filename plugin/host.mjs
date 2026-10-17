import { spawn as nodeSpawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-floatball-pet-host'
// Hard dependency, not `ctx.get('webServer')` at apply time: the service is not
// necessarily up when the plugin activates, and a lookup returning undefined leaves the
// settings page talking to a route nobody registered — every request then falls through
// to the SPA and comes back 404 (measured). Injecting it makes cordis start this plugin
// only once the HTTP carrier exists, which is how the other desktop plugins do it.
export const inject = ['webServer']

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXECUTABLE_NAME = 'DSH悬浮球.exe'
const REPO = 'riceyu02/dsh-floatball-pet'
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
const NPM_LATEST = 'https://registry.npmjs.org/dsh-floatball-pet/latest'
const NPM_LATEST_MIRROR = 'https://registry.npmmirror.com/dsh-floatball-pet/latest'
const UPDATE_TIMEOUT_MS = 8000
const RELEASE_TIMEOUT_MS = 12000
const ROUTE_PREFIX = '/.dsh-floatball-pet'
/** Installers to keep: the installed one plus the previous (offline rollback). */
const KEEP_INSTALLERS = 2

const PACKAGE_NAME = 'dsh-floatball-pet'

/** The profile manifest's spec for this package. */
export function selfSpec(manifest) {
  const spec = manifest && manifest.dependencies && manifest.dependencies[PACKAGE_NAME]
  return typeof spec === 'string' ? spec : null
}

/** `[whole, prefix]` of a release tarball of this package. */
function tarballMatch(name) {
  return /^(dsh-floatball-pet)-[0-9]+\.[0-9]+\.[0-9]+\.tgz$/.exec(name)
}

export function tarballVersion(name) {
  const match = tarballMatch(name)
  return match === null ? null : name.slice(match[1].length + 1, -'.tgz'.length)
}

function report(ctx, level, message) {
  try {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger(name) : null
    if (logger && typeof logger[level] === 'function') {
      logger[level](message)
      return
    }
  } catch {
    // Fall through to the process log. Logging must not break plugin startup.
  }
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'
  console[method](`[${name}] ${message}`)
}

/** Resolve the DSH home from a profile such as `<home>/profiles/desktop`. */
export function resolveDshHome(profileDir, env = process.env) {
  if (env.DSH_HOME) return path.resolve(env.DSH_HOME)
  const parent = path.dirname(path.resolve(profileDir))
  return path.basename(parent).toLowerCase() === 'profiles'
    ? path.dirname(parent)
    : path.resolve(profileDir)
}

/**
 * Where installs cache the assembled runtime: `<DSH_HOME>/dsh-floatball-pet/runtime/<electron
 * version>`. It lives outside the package on purpose — `node_modules/dsh-floatball-pet` is
 * deleted and recreated on every plugin upgrade, so a runtime kept inside it would be
 * rebuilt each time (and its file locks are what make pnpm report `ERR_PNPM_EPERM ...
 * runtime` while the ball is running). Keyed by Electron version alone, so upgrading the
 * plugin reuses it and only a new Electron release needs a new download.
 */
export function cachedRuntimeRoot(profileDir = process.cwd(), env = process.env) {
  if (env.DSH_PET_RUNTIME_DIR) return path.resolve(env.DSH_PET_RUNTIME_DIR)
  return path.join(resolveDshHome(profileDir, env), 'dsh-floatball-pet', 'runtime')
}

/**
 * The executable inside a runtime directory built by `tools/prepare-install.cjs`. The
 * `.ready.json` marker is written last, so a directory without one is an interrupted
 * assembly and is refused rather than used.
 */
function preparedRuntime(root) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  // Newest Electron first: after an upgrade the cache can hold more than one version,
  // and picking the older one would silently run a different engine than the package
  // was built against.
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => compareVersions(b, a))
  for (const version of versions) {
    const dir = path.join(root, version)
    if (!existsSync(path.join(dir, '.ready.json'))) continue
    const executable = [EXECUTABLE_NAME, 'electron.exe']
      .map(name => path.join(dir, name))
      .find(candidate => existsSync(candidate))
    if (executable !== undefined) return executable
  }
  return null
}

/**
 * Where the Electron helper lives, most specific first:
 *
 * 1. `DSH_PET_RUNTIME_EXE` — an explicit override, for tests and troubleshooting.
 * 2. `runtime/` inside the package — what the all-in-one tarball ships, so an install
 *    that already carries a runtime keeps using it and never touches the cache.
 * 3. `dist/DSH悬浮球` — a source checkout assembled by `tools/assemble.cjs`.
 * 4. the version-keyed cache from `tools/prepare-install.cjs` — what a published,
 *    runtime-less install relies on, and what makes an upgrade download nothing.
 *
 * Package-local paths stay ahead of the cache on purpose: an existing installation must
 * behave exactly as it did before the cache existed.
 */
export function resolveRuntime(packageRoot = PACKAGE_ROOT, env = process.env, profileDir) {
  const candidates = [
    env.DSH_PET_RUNTIME_EXE,
    path.join(packageRoot, 'runtime', EXECUTABLE_NAME),
    path.join(packageRoot, 'runtime', 'electron.exe'),
    path.join(packageRoot, 'dist', 'DSH悬浮球', EXECUTABLE_NAME),
    preparedRuntime(cachedRuntimeRoot(profileDir ?? packageRoot, env)),
  ].filter(Boolean)
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

/**
 * Keep the cached runtime's app code in step with the installed package.
 *
 * The cache is keyed by Electron version, so installing a new plugin version used to
 * reuse the old `resources/app` and the ball kept running the previous release's code.
 * Copy the code entries from the package into the cached app before launch; the Electron
 * binaries stay untouched. A full package keeps its app next to its own `runtime/` and is
 * already current, so it is skipped.
 *
 * @returns {boolean} whether the cached app was rewritten
 */
export function syncRuntimeApp(runtimePath, packageRoot = PACKAGE_ROOT, log = () => {}) {
  const runtimeDir = path.dirname(runtimePath)
  const target = path.join(runtimeDir, 'resources', 'app')
  if (!existsSync(target)) return false
  const root = path.resolve(packageRoot)
  if (path.resolve(runtimeDir) === root || path.resolve(runtimeDir).startsWith(root + path.sep)) return false
  const versionOf = (dir) => {
    try {
      return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version || ''
    } catch {
      return ''
    }
  }
  const version = versionOf(root)
  if (!version || versionOf(target) === version) return false
  const entries = [
    'src', 'plugin', 'build', 'tools', 'client.js', 'cordis.patch.yml', 'package.json',
    'node_modules/koffi', 'node_modules/@koromix',
  ]
  for (const entry of entries) {
    const source = path.join(root, entry)
    if (!existsSync(source)) continue
    const destination = path.join(target, entry)
    try {
      rmSync(destination, { recursive: true, force: true })
      mkdirSync(path.dirname(destination), { recursive: true })
      cpSync(source, destination, { recursive: true })
    } catch (error) {
      log('warn', `缓存运行时里的 ${entry} 没能更新：${error.message}`)
    }
  }
  writeFileSync(path.join(runtimeDir, '.app-version'), `${version}\n`)
  log('info', `缓存运行时应用已更新到 ${version}。`)
  return true
}

export function helperEnvironment({ profileDir, userDataDir, hostPid, dshUrl = null, noSandbox = false, gameProcesses = [], ignoreProcesses = [] }, env = process.env) {
  // The DSH host hands its own children `ELECTRON_RUN_AS_NODE=1` — that is how the CLI
  // and its helper scripts reuse the Electron binary as Node. Inherited by the pet it
  // does the same thing to it: the helper starts as a plain Node process, so no window
  // is ever created, the log stays empty and the process exits with code 0. That looks
  // exactly like "the ball never appears" (measured). The standalone launcher .cmd files
  // clear this variable for the same reason; this is the plugin-side equivalent.
  const {
    ELECTRON_RUN_AS_NODE: _runAsNode,
    ELECTRON_NO_ATTACH_CONSOLE: _noAttachConsole,
    ...inherited
  } = env
  return {
    ...inherited,
    DSH_HOME: resolveDshHome(profileDir, env),
    DSH_PROFILE_DIR: path.resolve(profileDir),
    // Which port DSH's web server is on. The pet decides "DSH is running" by connecting
    // to it and reads the uptime from the process start time once it has, so a wrong
    // port is not a detail: it is the island reporting 「未运行」 while DSH is on screen.
    // The port is ephemeral, so the only dependable answer comes from the process that
    // is listening — this one. Without it the pet falls back to a log file that may be
    // stale and to the port DSH used to keep, and on this machine both miss.
    ...(dshUrl ? { DSH_WEB_URL: dshUrl } : {}),
    DSH_PET_PLUGIN: '1',
    DSH_PET_PLUGIN_HOST_PID: String(hostPid),
    DSH_PET_USER_DATA: path.resolve(userDataDir),
    // Which full-screen windows count as games. Nothing in Windows answers that for
    // borderless full screen, so the pet takes a list: names to always treat as a game,
    // and names to never treat as one. Normalised here so the pet can compare the names
    // straight against the executable name it reads out of the window.
    ...(nameList(gameProcesses).length ? { DSH_PET_GAME_PROCESSES: nameList(gameProcesses).join(',') } : {}),
    ...(nameList(ignoreProcesses).length ? { DSH_PET_IGNORE_PROCESSES: nameList(ignoreProcesses).join(',') } : {}),
    ...(noSandbox ? { DSH_PET_NO_SANDBOX: '1' } : {}),
  }
}

/** Accepts `['a','b']` or `'a, b'` and normalises to lower-case executable names. */
export function nameList(value) {
  const parts = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return parts.map(entry => String(entry).trim().toLowerCase().replace(/\.exe$/, '')).filter(Boolean)
}

/**
 * Own the helper process without tying the DSH host event loop to it.  A very
 * early abnormal exit gets one compatibility-mode retry for Chromium sandbox
 * failures; normal user exits are respected until DSH itself restarts.
 */
export class PetSupervisor {
  constructor(options) {
    this.runtimePath = options.runtimePath
    this.profileDir = options.profileDir
    this.userDataDir = options.userDataDir
    this.gameProcesses = options.gameProcesses ?? []
    this.ignoreProcesses = options.ignoreProcesses ?? []
    this.hostPid = options.hostPid ?? process.pid
    this.platform = options.platform ?? process.platform
    this.spawn = options.spawn ?? nodeSpawn
    this.log = options.log ?? (() => {})
    this.retryDelayMs = options.retryDelayMs ?? 300
    // A string, or a function read at every launch: the web server may not be listening
    // when the plugin is applied, and a retry has to see the address that exists then.
    this.dshUrl = options.dshUrl ?? null
    this.child = null
    this.retryTimer = null
    this.stopping = false
    this.compatibilityAttempted = false
  }

  /** True while a helper process is believed to be running. */
  get running() {
    return Boolean(this.child) && !this.stopping
  }

  start() {
    if (this.platform !== 'win32') {
      this.log('warn', '当前悬浮球运行时仅支持 Windows，插件已加载但不会创建桌面窗口。')
      return false
    }
    if (!this.runtimePath || !existsSync(this.runtimePath)) {
      this.log('error', `找不到悬浮球运行时：${this.runtimePath || '(未配置)'}`)
      return false
    }
    mkdirSync(this.userDataDir, { recursive: true })
    this.stopping = false
    this.#launch(false)
    return true
  }

  #launch(noSandbox) {
    const startedAt = Date.now()
    try {
      syncRuntimeApp(this.runtimePath, PACKAGE_ROOT, (level, message) => this.log(level, message))
    } catch (error) {
      this.log('warn', `缓存运行时应用更新失败：${error.message}`)
    }
    const args = noSandbox ? ['--no-sandbox'] : []
    const child = this.spawn(this.runtimePath, args, {
      cwd: path.dirname(this.runtimePath),
      windowsHide: false,
      stdio: 'ignore',
      env: helperEnvironment({
        profileDir: this.profileDir,
        userDataDir: this.userDataDir,
        hostPid: this.hostPid,
        dshUrl: typeof this.dshUrl === 'function' ? this.dshUrl() : this.dshUrl,
        noSandbox,
        gameProcesses: this.gameProcesses,
        ignoreProcesses: this.ignoreProcesses,
      }),
    })
    this.child = child
    child.unref?.()
    this.log('info', `悬浮球已启动（${noSandbox ? '兼容' : '标准'}模式，pid=${child.pid ?? '?' }）。`)

    child.once('error', (error) => {
      if (this.child === child) this.child = null
      this.log('error', `悬浮球进程启动失败：${error.message}`)
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      if (this.stopping) return
      const earlyFailure = Date.now() - startedAt < 5000 && (code !== 0 || signal != null)
      if (!noSandbox && earlyFailure && !this.compatibilityAttempted) {
        this.compatibilityAttempted = true
        this.log('warn', '标准模式过早退出，改用 Chromium 兼容模式重试一次。')
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          if (!this.stopping) this.#launch(true)
        }, this.retryDelayMs)
        this.retryTimer.unref?.()
        return
      }
      this.log(code === 0 ? 'info' : 'error', `悬浮球已退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）。`)
    })
  }

  stop() {
    this.stopping = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const child = this.child
    this.child = null
    if (!child || child.killed) return
    try {
      child.kill()
    } catch (error) {
      this.log('warn', `停止悬浮球时出错：${error.message}`)
    }
  }
}

/* ------------------------------------------------------------------ updates --- */

/** The package version this install carries. */
export function installedVersion(packageRoot = PACKAGE_ROOT) {
  try {
    return JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function compareVersions(a, b) {
  const left = String(a).replace(/^v/, '').split('.')
  const right = String(b).replace(/^v/, '').split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = Number.parseInt(left[index] || '0', 10) || 0
    const r = Number.parseInt(right[index] || '0', 10) || 0
    if (l !== r) return l > r ? 1 : -1
  }
  return 0
}

/**
 * Requests go through Electron's net when the host process has it: Chromium then
 * applies the machine's proxy settings, which is the difference between working and
 * timing out where github.com is only reachable through a proxy. Plain `fetch` is the
 * fallback for a headless run.
 */
async function fetchJson(url, timeoutMs = 20000) {
  const viaElectron = await electronRequest(url, { json: true, timeoutMs })
  if (viaElectron !== undefined) return viaElectron
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `dsh-floatball-pet${installedVersion()}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`)
  return response.json()
}

/** Returns undefined when Electron is not around; throws on a real request failure. */
async function electronRequest(url, { json = false, timeoutMs = 20000 } = {}) {
  let net
  try {
    ({ net } = await import('electron'))
  } catch {
    return undefined
  }
  if (!net || typeof net.request !== 'function') return undefined
  return await new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow' })
    request.setHeader('User-Agent', `dsh-floatball-pet${installedVersion()}`)
    if (json) request.setHeader('Accept', 'application/vnd.github+json')
    const timer = setTimeout(() => {
      request.abort()
      reject(new Error('请求超时'))
    }, timeoutMs)
    request.on('response', (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        clearTimeout(timer)
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`))
          return
        }
        const buffer = Buffer.concat(chunks)
        if (!json) {
          resolve(buffer)
          return
        }
        try { resolve(JSON.parse(buffer.toString('utf8'))) } catch (error) { reject(error) }
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

/** The latest version published on npm, official registry first, mirror second. */
async function npmLatest() {
  for (const url of [NPM_LATEST, NPM_LATEST_MIRROR]) {
    try {
      const data = await fetchJson(url, UPDATE_TIMEOUT_MS)
      const version = String((data && data.version) || '').replace(/^v/, '')
      if (version) return { version }
    } catch {
      // try the next registry
    }
  }
  return null
}

/**
 * Pick the `.tgz` a modern client should fall back to. Prefer the thin package: the
 * `-full` asset exists only for 0.1.0's older updater, which grabs the first `.tgz` and
 * cannot run install scripts. A modern client downloads ~1.7 MB even when npm is down.
 */
export function pickReleaseAsset(assets) {
  const tarballs = (assets || []).filter((entry) => /\.tgz$/i.test(entry.name || ''))
  return tarballs.find((entry) => !/-full\.tgz$/i.test(entry.name)) ?? tarballs[0] ?? null
}

/** The latest GitHub release and its installer asset. */
async function githubLatest() {
  const release = await fetchJson(API_LATEST, RELEASE_TIMEOUT_MS)
  const version = String(release.tag_name || '').replace(/^v/, '')
  const asset = pickReleaseAsset(release.assets)
  return {
    version,
    pageUrl: release.html_url || `https://github.com/${REPO}/releases`,
    assetName: asset ? asset.name : null,
    assetUrl: asset ? asset.browser_download_url : null,
    assetSize: asset ? asset.size : null,
  }
}

/**
 * Pick the newer of the two sources. npm wins ties: it fetches only the package, while a
 * release asset may still carry the runtime.
 */
export function chooseUpdate(current, npm, release) {
  const candidates = []
  if (npm && npm.version) candidates.push({ source: 'npm', latest: npm.version })
  if (release && release.version && release.assetUrl) candidates.push({ source: 'release', latest: release.version })
  let best = null
  for (const candidate of candidates) {
    if (compareVersions(candidate.latest, current) <= 0) continue
    if (best === null || compareVersions(candidate.latest, best.latest) > 0) best = candidate
  }
  return best
}

/** Latest version from npm and GitHub, compared with what is installed. */
export async function checkLatest(packageRoot = PACKAGE_ROOT) {
  const current = installedVersion(packageRoot)
  const [npm, release] = await Promise.all([
    npmLatest().catch(() => null),
    githubLatest().catch(() => null),
  ])
  const chosen = chooseUpdate(current, npm, release)
  let latest = current
  for (const candidate of [npm, release]) {
    if (candidate && candidate.version && compareVersions(candidate.version, latest) > 0) latest = candidate.version
  }
  // The release asset is only a fallback when it is not older than what we are about to
  // install: an npm release can appear before its GitHub release does.
  const usableAsset = Boolean(release && release.assetUrl
    && (!chosen || chosen.source === 'release' || compareVersions(release.version, chosen.latest) >= 0))
  return {
    current,
    latest,
    newer: chosen !== null,
    source: chosen ? chosen.source : null,
    npmVersion: chosen && chosen.source === 'npm' ? chosen.latest : null,
    pageUrl: (release && release.pageUrl) || `https://github.com/${REPO}/releases`,
    assetName: usableAsset ? release.assetName : null,
    assetUrl: usableAsset ? release.assetUrl : null,
    assetSize: usableAsset ? release.assetSize : null,
  }
}

/** The DSH CLI entry inside the running installation. */
export function dshCliPath(resourcesPath = process.resourcesPath) {
  if (!resourcesPath) return null
  const candidate = path.join(resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  return existsSync(candidate) ? candidate : null
}

function download(url) {
  return electronRequest(url, { json: false, timeoutMs: 600000 }).then(async (buffer) => {
    if (buffer !== undefined) return buffer
    const response = await fetch(url, { signal: AbortSignal.timeout(600000) })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  })
}

/**
 * Delete installers of versions we have moved past (the directory people back up). The
 * one the profile points at is never touched — removing that breaks the next
 * `pnpm install` — and neither are the newest couple, which are the rollback.
 */
export function cleanupOldInstallers(profileDir, justInstalled = null) {
  const directory = path.join(profileDir, 'plugin-tarballs')
  const removed = []
  try {
    const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const spec = selfSpec(manifest)
    const keep = new Set()
    if (typeof spec === 'string' && spec.startsWith('file:')) keep.add(path.resolve(profileDir, spec.slice('file:'.length)))
    if (justInstalled) keep.add(path.resolve(justInstalled))
    const names = readdirSync(directory)
      .filter((entry) => tarballMatch(entry) !== null)
      .sort((a, b) => compareVersions(tarballVersion(b), tarballVersion(a)))
    for (const name of names.slice(0, KEEP_INSTALLERS)) keep.add(path.resolve(directory, name))
    for (const name of names) {
      const full = path.resolve(directory, name)
      if (keep.has(full)) continue
      try {
        rmSync(full, { force: true })
        removed.push(name)
      } catch { /* locked or already gone */ }
    }
  } catch {
    // No readable manifest, no opinion.
  }
  return removed
}

/** Download (or reuse) the release installer inside the profile. */
async function fetchInstaller(release, profileDir) {
  const tarballDir = path.join(profileDir, 'plugin-tarballs')
  mkdirSync(tarballDir, { recursive: true })
  const target = path.join(tarballDir, release.assetName)
  if (!existsSync(target)) {
    const buffer = await download(release.assetUrl)
    const partial = `${target}.part`
    writeFileSync(partial, buffer)
    renameSync(partial, target)
  }
  return target
}

/** Run a pnpm command through the DSH CLI in the profile and capture its output. */
function runDshCli(cli, profileDir, args) {
  return new Promise((resolve) => {
    const child = nodeSpawn(process.execPath, [
      '--expose-internals', cli, 'plugin', '--profile', path.basename(profileDir), ...args,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
    let output = ''
    child.stdout?.on('data', (chunk) => { output += chunk })
    child.stderr?.on('data', (chunk) => { output += chunk })
    child.once('exit', (code) => resolve({ code, output }))
    child.once('error', (error) => resolve({ code: -1, output: error.message }))
  })
}

/**
 * pnpm 11 refuses to run a dependency's install scripts until their exact key is listed
 * under `allowBuilds` in the profile's pnpm-workspace.yaml. The key is `name@<resolved
 * spec>` — for a file install that includes the tarball path, which is why a bare package
 * name is not enough.
 */
function allowBuildScripts(profileDir, keys) {
  const file = path.join(profileDir, 'pnpm-workspace.yaml')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  const missing = keys.filter((key) => !text.includes(`"${key}": true`))
  if (missing.length === 0) return
  const lines = missing.map((key) => `  "${key}": true`).join('\n')
  if (/^allowBuilds:[ \t]*$/m.test(text)) {
    text = text.replace(/^allowBuilds:[ \t]*$/m, `allowBuilds:\n${lines}`)
  } else {
    text = `${text.replace(/\s*$/, '')}\n\nallowBuilds:\n${lines}\n`
  }
  try {
    writeFileSync(file, text)
  } catch {
    // best effort: the install then fails with pnpm's own message
  }
}

/** The pnpm `allowBuilds` key a tarball install resolves to. */
function fileBuildKey(assetName) {
  return `${PACKAGE_NAME}@file:plugin-tarballs/${assetName}`
}

/**
 * Install one spec, allowing this package's build scripts first. When pnpm still reports
 * ignored builds, the package itself is already in place — approving and rebuilding runs
 * the runtime hook, which hits the cache we just populated.
 */
async function installViaCli(cli, profileDir, spec, buildKeys, log) {
  allowBuildScripts(profileDir, buildKeys)
  let result = await runDshCli(cli, profileDir, ['add', spec])
  if (result.code !== 0 && /IGNORED_BUILDS/.test(result.output)) {
    const rebuild = await runDshCli(cli, profileDir, ['rebuild', PACKAGE_NAME])
    if (rebuild.code === 0) {
      log('info', '已放行构建脚本并完成安装')
      result = { code: 0, output: `${result.output}\n${rebuild.output}` }
    }
  }
  return result
}

/**
 * Move the runtime of the package being replaced into the version-keyed cache. A fat
 * install carries Electron inside the package; after switching to the npm package that
 * directory is gone, and without this copy the next install would download 110 MB again.
 * The marker is what `prepare-install.cjs` treats as a completed assembly.
 */
function ensureRuntimeCached(profileDir, log) {
  const packageRuntime = path.join(PACKAGE_ROOT, 'runtime')
  if (!existsSync(packageRuntime)) return null
  let version
  try {
    version = readFileSync(path.join(packageRuntime, 'version'), 'utf8').trim()
  } catch {
    return null
  }
  if (!version) return null
  const target = path.join(cachedRuntimeRoot(profileDir), version)
  if (existsSync(path.join(target, '.ready.json'))) return target
  try {
    log('info', `把现有运行时缓存到 ${target}`)
    mkdirSync(target, { recursive: true })
    cpSync(packageRuntime, target, { recursive: true })
    writeFileSync(path.join(target, '.ready.json'), JSON.stringify({
      electronVersion: version,
      source: 'migrated',
      completedAt: new Date().toISOString(),
    }, null, 2))
    return target
  } catch (error) {
    log('warn', `缓存现有运行时失败：${error.message}`)
    return null
  }
}

/**
 * Install the new version. npm is the cheap path (package only, runtime comes from the
 * cache); the GitHub asset is both the explicit source when npm is behind and the
 * fallback when the npm install fails.
 *
 * Stopping the helper first is not optional: its executable sits inside the package pnpm
 * replaces, and a half-replaced package is a profile DSH cannot boot from. DSH itself
 * needs a restart afterwards — a new module generation cannot be loaded into a running
 * process.
 */
export async function applyUpdate({ release, profileDir, supervisor, log = () => {} }) {
  const viaNpm = Boolean(release && release.source === 'npm' && release.npmVersion)
  const canFallback = Boolean(release && release.assetUrl && release.assetName)
  if (!viaNpm && !canFallback) throw new Error('这个版本没有可用的安装源')

  let target = null
  if (!viaNpm) target = await fetchInstaller(release, profileDir)

  supervisor?.stop()
  await new Promise((resolve) => setTimeout(resolve, 1500))
  ensureRuntimeCached(profileDir, log)

  const cli = dshCliPath()
  if (!cli) throw new Error('找不到 DSH 的 CLI，无法自动安装')

  let result
  let source = 'release'
  if (viaNpm) {
    source = 'npm'
    const spec = `${PACKAGE_NAME}@${release.npmVersion}`
    result = await installViaCli(cli, profileDir, spec, [spec, PACKAGE_NAME], log)
    if (result.code !== 0 && canFallback) {
      log('warn', 'npm 安装失败，改用 GitHub 安装包重试')
      target = await fetchInstaller(release, profileDir)
      result = await installViaCli(cli, profileDir, target, [fileBuildKey(release.assetName)], log)
      source = 'release'
    }
  } else {
    result = await installViaCli(cli, profileDir, target, [fileBuildKey(release.assetName)], log)
  }

  log(result.code === 0 ? 'info' : 'error', `更新安装结束：code=${result.code}`)
  const removed = result.code === 0 ? cleanupOldInstallers(profileDir, target) : []
  if (removed.length) log('info', `已清理旧安装包：${removed.join(', ')}`)
  return {
    ok: result.code === 0,
    code: result.code,
    source,
    version: release.latest || release.npmVersion || null,
    tarball: target,
    removed,
    output: result.output.slice(-2000),
  }
}

/* ------------------------------------------------------------------- routes --- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

/* ---------------------------------------------------- preferences shared with pet */

const SETTING_DEFAULTS = {
  ballSize: 56,
  opacity: 1,
  islandPinned: false,
  islandColor: null,
  gearColor: null,
  ballImage: null,
  ballImageScale: 1,
  ballImageOffsetX: 0,
  ballImageOffsetY: 0,
  showBalance: true,
  showUptime: true,
}

const COLOR_RE = /^#[0-9a-f]{6}$/i

function preferencesFile(userDataDir) {
  return path.join(userDataDir, 'preferences.json')
}

function readPreferences(userDataDir) {
  try {
    const parsed = JSON.parse(readFileSync(preferencesFile(userDataDir), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writePreferences(userDataDir, data) {
  mkdirSync(userDataDir, { recursive: true })
  const file = preferencesFile(userDataDir)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file)
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

/**
 * Merge one patch from the DSH settings page into preferences.json. The pet watches
 * this file, so writing it is enough to move the ball — there is no second IPC path.
 */
export function patchPreferences(userDataDir, patch) {
  const current = readPreferences(userDataDir)
  const next = { ...SETTING_DEFAULTS, ...current }
  if ('ballSize' in patch) next.ballSize = Math.round(clampNumber(patch.ballSize, 40, 96, next.ballSize))
  if ('opacity' in patch) next.opacity = clampNumber(patch.opacity, 0.35, 1, next.opacity)
  if ('islandPinned' in patch) next.islandPinned = patch.islandPinned === true
  if ('islandColor' in patch) {
    next.islandColor = COLOR_RE.test(String(patch.islandColor || '')) ? String(patch.islandColor) : null
  }
  if ('gearColor' in patch) {
    next.gearColor = COLOR_RE.test(String(patch.gearColor || '')) ? String(patch.gearColor) : null
  }
  if ('ballImageScale' in patch) next.ballImageScale = clampNumber(patch.ballImageScale, 1, 4, next.ballImageScale)
  // Offsets are a percentage of the available pan room, not of the ball diameter:
  // ±100 means "the image edge is exactly on the circle edge". Keeping them in this
  // range is what guarantees the picture always covers the round preview, whatever
  // its aspect ratio or zoom.
  if ('ballImageOffsetX' in patch) next.ballImageOffsetX = clampNumber(patch.ballImageOffsetX, -100, 100, next.ballImageOffsetX)
  if ('ballImageOffsetY' in patch) next.ballImageOffsetY = clampNumber(patch.ballImageOffsetY, -100, 100, next.ballImageOffsetY)
  if ('showBalance' in patch) next.showBalance = patch.showBalance !== false
  if ('showUptime' in patch) next.showUptime = patch.showUptime !== false
  if ('ballImage' in patch) {
    next.ballImage = patch.ballImage === null
      ? null
      : (typeof patch.ballImage === 'string' && patch.ballImage ? patch.ballImage : next.ballImage)
    if (next.ballImage === null) {
      next.ballImageScale = 1
      next.ballImageOffsetX = 0
      next.ballImageOffsetY = 0
    }
  }
  writePreferences(userDataDir, next)
  return next
}

function ballImageVersion(settings) {
  if (typeof settings.ballImage !== 'string' || !settings.ballImage) return null
  try {
    return statSync(settings.ballImage).mtimeMs
  } catch {
    return null
  }
}

export function settingsPayload(userDataDir) {
  const settings = { ...SETTING_DEFAULTS, ...readPreferences(userDataDir) }
  return {
    settings,
    ballImageName: typeof settings.ballImage === 'string' && settings.ballImage
      ? path.basename(settings.ballImage)
      : null,
    // Cache-busting stamp for GET /icon. The path alone is not enough: a picture
    // picked from the same folder can reuse the same name, and the settings page
    // must show the new file rather than the browser's copy of the old one.
    ballImageVersion: ballImageVersion(settings),
  }
}

const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/** A file can be a valid image under an unrelated name; the bytes decide. */
function sniffImageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return 'application/octet-stream'
}

/** The picture the settings page previews: the user's icon, or the built-in art. */
export function iconPayload(userDataDir) {
  const settings = { ...SETTING_DEFAULTS, ...readPreferences(userDataDir) }
  const fallback = path.join(PACKAGE_ROOT, 'src', 'renderer', 'assets', 'avatar.png')
  const file = typeof settings.ballImage === 'string' && settings.ballImage
    ? settings.ballImage
    : fallback
  for (const candidate of [file, fallback]) {
    try {
      const bytes = readFileSync(candidate)
      const ext = path.extname(candidate).slice(1).toLowerCase()
      return { bytes, type: IMAGE_MIME[ext] || sniffImageMime(bytes) }
    } catch {
      /* try the built-in art next */
    }
  }
  return null
}

const ICON_TYPES = {
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  webp: 'webp',
  gif: 'gif',
  bmp: 'bmp',
}

/** Save a data-URL image from the settings page next to preferences.json. */
export function saveIcon(userDataDir, dataUrl) {
  const match = /^data:image\/([a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''))
  if (!match) throw new Error('图标数据格式不对（需要 PNG / JPG / GIF / WebP / BMP 的 data URL）')
  const ext = ICON_TYPES[match[1].toLowerCase()]
  if (!ext) throw new Error(`不支持的图片类型：${match[1]}`)
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length) throw new Error('图标文件是空的')
  if (bytes.length > 12 * 1024 * 1024) throw new Error('图标太大（最大 12 MB）')
  mkdirSync(userDataDir, { recursive: true })
  const name = `custom-icon-${Date.now()}.${ext}`
  const file = path.join(userDataDir, name)
  writeFileSync(file, bytes)
  // Old crops must not pile up next to the profile.
  for (const entry of readdirSync(userDataDir)) {
    if (entry !== name && entry.startsWith('custom-icon-')) {
      try { rmSync(path.join(userDataDir, entry), { force: true }) } catch { /* in use */ }
    }
  }
  return file
}

/**
 * What the settings page inside DSH talks to. Client plugins reach their host over HTTP
 * on the same origin (the pattern the other desktop plugins use), so the page can read
 * state and ask for an update without knowing about cordis services.
 */
function registerRoutes(ctx, state) {
  const webServer = ctx?.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    report(ctx, 'warn', 'webServer 服务不可用：DSH 设置页里的灵动岛悬浮球面板不会出现。')
    return null
  }
  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      try {
        if (req.method === 'GET' && (route === '/' || route === '/status')) {
          sendJson(res, 200, {
            ok: true,
            version: installedVersion(),
            profile: path.basename(state.profileDir),
            running: state.supervisor.running,
            enabled: state.enabled,
            runtimeReady: Boolean(state.supervisor.runtimePath),
            canUpdate: Boolean(dshCliPath()),
          })
          return
        }
        if (req.method === 'GET' && route === '/settings') {
          sendJson(res, 200, { ok: true, ...settingsPayload(state.userDataDir) })
          return
        }
        if (req.method === 'GET' && route === '/icon') {
          // Raw bytes rather than a data URL in /settings: an animated GIF stays an
          // animated GIF, and the page can keep using a plain <img src>.
          const icon = iconPayload(state.userDataDir)
          if (!icon) {
            sendJson(res, 404, { ok: false, error: '没有可预览的图标' })
            return
          }
          res.writeHead(200, {
            'content-type': icon.type,
            'content-length': icon.bytes.length,
            'cache-control': 'no-store',
          })
          res.end(icon.bytes)
          return
        }
        if (req.method === 'POST' && route === '/settings') {
          const body = await readJsonBody(req)
          const settings = patchPreferences(state.userDataDir, body || {})
          sendJson(res, 200, {
            ok: true,
            settings,
            ballImageName: settings.ballImage ? path.basename(settings.ballImage) : null,
            ballImageVersion: ballImageVersion(settings),
          })
          return
        }
        if (req.method === 'POST' && route === '/icon') {
          const body = await readJsonBody(req)
          const file = saveIcon(state.userDataDir, body?.dataUrl)
          const patch = { ballImage: file }
          if (Number.isFinite(Number(body?.scale))) patch.ballImageScale = body.scale
          if (Number.isFinite(Number(body?.offsetX))) patch.ballImageOffsetX = body.offsetX
          if (Number.isFinite(Number(body?.offsetY))) patch.ballImageOffsetY = body.offsetY
          const settings = patchPreferences(state.userDataDir, patch)
          sendJson(res, 200, {
            ok: true,
            settings,
            ballImageName: settings.ballImage ? path.basename(settings.ballImage) : null,
            ballImageVersion: ballImageVersion(settings),
          })
          return
        }
        if (req.method === 'POST' && route === '/ball') {
          const body = await readJsonBody(req)
          const enabled = body.enabled !== false
          state.setEnabled(enabled)
          sendJson(res, 200, { ok: true, enabled, running: state.supervisor.running })
          return
        }
        if (req.method === 'POST' && route === '/check') {
          sendJson(res, 200, { ok: true, ...(await checkLatest()) })
          return
        }
        if (req.method === 'POST' && route === '/update') {
          const body = await readJsonBody(req)
          const release = body && body.latest ? body : await checkLatest()
          if (!release.newer && !body.force) {
            sendJson(res, 200, { ok: true, alreadyLatest: true, version: release.current })
            return
          }
          const result = await applyUpdate({
            release,
            profileDir: state.profileDir,
            supervisor: state.supervisor,
            log: (level, message) => report(ctx, level, message),
          })
          state.enabled = true
          sendJson(res, 200, { ...result, version: release.latest, restartRequired: result.ok })
          return
        }
        sendJson(res, 404, { ok: false, error: `unknown route ${route}` })
      } catch (error) {
        report(ctx, 'error', `设置页接口出错：${error.message}`)
        sendJson(res, 500, { ok: false, error: error.message })
      }
    },
  })
}

export function apply(ctx, config = {}) {
  const profileContext = typeof ctx?.get === 'function' ? ctx.get('profileContext') : null
  const profileDir = path.resolve(
    config.profileDir
      || profileContext?.dir
      || process.env.DSH_PROFILE_DIR
      || process.cwd(),
  )
  const userDataDir = path.resolve(config.userDataDir || path.join(profileDir, 'data', 'dsh-floatball-pet'))
  const runtimePath = config.runtimePath || resolveRuntime(PACKAGE_ROOT, process.env, profileDir)
  const supervisor = new PetSupervisor({
    runtimePath,
    profileDir,
    userDataDir,
    // Where DSH's web server actually listens, read from the server itself. This is the
    // one address the pet cannot derive on its own: the port is ephemeral, and the log
    // it used to read is a leftover from a launcher that may never have run. Read on
    // every launch, because a retry after the port exists must see the new value.
    dshUrl: () => {
      try {
        const origin = ctx?.webServer?.getOrigin?.()
        return typeof origin === 'string' && origin ? origin : null
      } catch {
        // `getOrigin` throws until the listener has bound; the pet then finds the port
        // itself (see `lookupDshPort` in src/dsh.js).
        return null
      }
    },
    // Which full-screen windows the pet treats as a game. `gameProcesses` forces a
    // program to count (add your game if it is missed); `ignoreProcesses` keeps one out
    // (add your video player if a borderless full-screen video hides the ball).
    gameProcesses: nameList(config.gameProcesses),
    ignoreProcesses: nameList(config.ignoreProcesses),
    log: (level, message) => report(ctx, level, message),
  })

  // Switching the ball off from the DSH settings page only stops the helper. Every
  // preference of the island lives in the pet's own store and is left untouched; the
  // choice is remembered so restarting DSH does not silently bring the ball back.
  const switchFile = path.join(userDataDir, 'ball-enabled.json')
  const readEnabled = () => {
    try {
      return JSON.parse(readFileSync(switchFile, 'utf8')).enabled !== false
    } catch {
      return config.startEnabled !== false
    }
  }
  const state = {
    profileDir,
    userDataDir,
    supervisor,
    enabled: readEnabled(),
    setEnabled(enabled) {
      state.enabled = enabled
      try {
        mkdirSync(userDataDir, { recursive: true })
        writeFileSync(switchFile, JSON.stringify({ enabled, at: Date.now() }, null, 2))
      } catch (error) {
        report(ctx, 'warn', `记不住悬浮球开关状态：${error.message}`)
      }
      if (enabled) supervisor.start()
      else supervisor.stop()
    },
  }

  const routeDisposer = registerRoutes(ctx, state)

  ctx.effect(() => {
    if (state.enabled) supervisor.start()
    else report(ctx, 'info', '悬浮球在 DSH 设置页里被关掉了，本次不启动。')
    return () => {
      supervisor.stop()
      try { routeDisposer?.() } catch { /* already disposed */ }
    }
  })
}
