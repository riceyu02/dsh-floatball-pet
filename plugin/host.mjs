import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-desktop-pet-host'
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
const ROUTE_PREFIX = '/.dsh-desktop-pet'
/** Installers to keep: the installed one plus the previous (offline rollback). */
const KEEP_INSTALLERS = 2

/**
 * The names this package can be installed under. A profile installed from a `file:` tarball
 * or from npm uses the scoped name; the release tarballs do not, and neither do profiles
 * installed before the scope existed. Every lookup that reads the profile manifest has to
 * accept either, or an older installation silently stops having its old installers cleaned
 * up. `tools/prepare-install.cjs` keeps the same list for the same reason.
 */
const PACKAGE_NAMES = ['dsh-floatball-pet', 'dsh-desktop-pet']

/** The profile manifest's spec for this package, whichever name it was installed under. */
export function selfSpec(manifest) {
  for (const name of PACKAGE_NAMES) {
    const spec = manifest && manifest.dependencies && manifest.dependencies[name]
    if (typeof spec === 'string') return spec
  }
  return null
}

/** `[whole, prefix]` of a release tarball of this package, for either naming scheme. */
function tarballMatch(name) {
  return /^((?:dsh-floatball-pet|dsh-desktop-pet))-[0-9]+\.[0-9]+\.[0-9]+\.tgz$/.exec(name)
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
 * Where installs cache the assembled runtime: `<DSH_HOME>/dsh-desktop-pet/runtime/<electron
 * version>`. It lives outside the package on purpose — `node_modules/dsh-floatball-pet` is
 * deleted and recreated on every plugin upgrade, so a runtime kept inside it would be
 * rebuilt each time (and its file locks are what make pnpm report `ERR_PNPM_EPERM ...
 * runtime` while the ball is running). Keyed by Electron version alone, so upgrading the
 * plugin reuses it and only a new Electron release needs a new download.
 *
 * The directory keeps the old product name on purpose: renaming it would make every
 * installed profile download 269 MB again and lose its ball size, position and opacity.
 */
export function cachedRuntimeRoot(profileDir = process.cwd(), env = process.env) {
  if (env.DSH_PET_RUNTIME_DIR) return path.resolve(env.DSH_PET_RUNTIME_DIR)
  return path.join(resolveDshHome(profileDir, env), 'dsh-desktop-pet', 'runtime')
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
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
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
 * 3. `dist/DSH悬浮球` — a source checkout assembled by `npm run pack`.
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
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
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

/** Latest release, compared with what is installed. */
export async function checkLatest(packageRoot = PACKAGE_ROOT) {
  const current = installedVersion(packageRoot)
  const release = await fetchJson(API_LATEST)
  const latest = String(release.tag_name || '').replace(/^v/, '')
  const asset = (release.assets || []).find((entry) => /\.tgz$/i.test(entry.name || ''))
  return {
    current,
    latest,
    newer: Boolean(latest) && compareVersions(latest, current) > 0,
    pageUrl: release.html_url || `https://github.com/${REPO}/releases`,
    assetName: asset ? asset.name : null,
    assetUrl: asset ? asset.browser_download_url : null,
    assetSize: asset ? asset.size : null,
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
 * Delete installers of versions we have moved past (113 MB each, in the directory people
 * back up). The one the profile points at is never touched — removing that breaks the
 * next `pnpm install` — and neither are the newest couple, which are the rollback.
 */
export function cleanupOldInstallers(profileDir, justInstalled = null) {
  const directory = path.join(profileDir, 'plugin-tarballs')
  const removed = []
  try {
    const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const spec = selfSpec(manifest)
    if (typeof spec !== 'string' || !spec.startsWith('file:')) return removed
    const keep = new Set([path.resolve(profileDir, spec.slice('file:'.length))])
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

/**
 * Download the new installer, stop the helper, then let the DSH CLI install it.
 *
 * Stopping first is not optional: the helper's executable sits inside the package pnpm
 * has to replace, and a half-replaced package is a profile DSH cannot boot from. DSH
 * itself needs a restart afterwards — a new module generation cannot be loaded into a
 * running process.
 */
export async function applyUpdate({ release, profileDir, supervisor, log = () => {} }) {
  if (!release || !release.assetUrl || !release.assetName) throw new Error('这个 Release 没有可用的 .tgz 附件')
  const tarballDir = path.join(profileDir, 'plugin-tarballs')
  mkdirSync(tarballDir, { recursive: true })
  const target = path.join(tarballDir, release.assetName)
  if (!existsSync(target)) {
    const buffer = await download(release.assetUrl)
    const partial = `${target}.part`
    writeFileSync(partial, buffer)
    renameSync(partial, target)
  }

  supervisor?.stop()
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const cli = dshCliPath()
  if (!cli) throw new Error('找不到 DSH 的 CLI，无法自动安装')
  const result = await new Promise((resolve) => {
    const child = nodeSpawn(process.execPath, [
      '--expose-internals', cli, 'plugin', '--profile', path.basename(profileDir), 'add', target,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
    let output = ''
    child.stdout?.on('data', (chunk) => { output += chunk })
    child.stderr?.on('data', (chunk) => { output += chunk })
    child.once('exit', (code) => resolve({ code, output }))
    child.once('error', (error) => resolve({ code: -1, output: error.message }))
  })
  log(result.code === 0 ? 'info' : 'error', `更新安装结束：code=${result.code}`)
  const removed = result.code === 0 ? cleanupOldInstallers(profileDir, target) : []
  if (removed.length) log('info', `已清理旧安装包：${removed.join(', ')}`)
  return { ok: result.code === 0, code: result.code, tarball: target, removed, output: result.output.slice(-2000) }
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
          const release = body && body.assetUrl ? body : await checkLatest()
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
  const userDataDir = path.resolve(config.userDataDir || path.join(profileDir, 'data', 'dsh-desktop-pet'))
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
