import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-desktop-pet-host'
export const inject = []

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXECUTABLE_NAME = 'DSH悬浮球.exe'

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
 * A packed plugin keeps the Electron helper in `runtime/`.  The second path is
 * intentionally retained for `dsh plugin add link:<checkout>` development.
 */
export function resolveRuntime(packageRoot = PACKAGE_ROOT, env = process.env) {
  const candidates = [
    env.DSH_PET_RUNTIME_EXE,
    path.join(packageRoot, 'runtime', EXECUTABLE_NAME),
    path.join(packageRoot, 'runtime', 'electron.exe'),
    path.join(packageRoot, 'dist', 'DSH悬浮球', EXECUTABLE_NAME),
  ].filter(Boolean)
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

export function helperEnvironment({ profileDir, userDataDir, hostPid, noSandbox = false }, env = process.env) {
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
    DSH_PET_PLUGIN: '1',
    DSH_PET_PLUGIN_HOST_PID: String(hostPid),
    DSH_PET_USER_DATA: path.resolve(userDataDir),
    ...(noSandbox ? { DSH_PET_NO_SANDBOX: '1' } : {}),
  }
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
    this.hostPid = options.hostPid ?? process.pid
    this.platform = options.platform ?? process.platform
    this.spawn = options.spawn ?? nodeSpawn
    this.log = options.log ?? (() => {})
    this.retryDelayMs = options.retryDelayMs ?? 300
    this.child = null
    this.retryTimer = null
    this.stopping = false
    this.compatibilityAttempted = false
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
        noSandbox,
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

export function apply(ctx, config = {}) {
  const profileContext = typeof ctx?.get === 'function' ? ctx.get('profileContext') : null
  const profileDir = path.resolve(
    config.profileDir
      || profileContext?.dir
      || process.env.DSH_PROFILE_DIR
      || process.cwd(),
  )
  const userDataDir = path.resolve(config.userDataDir || path.join(profileDir, 'data', 'dsh-desktop-pet'))
  const runtimePath = config.runtimePath || resolveRuntime()
  const supervisor = new PetSupervisor({
    runtimePath,
    profileDir,
    userDataDir,
    log: (level, message) => report(ctx, level, message),
  })

  ctx.effect(() => {
    if (config.autoStart !== false) supervisor.start()
    return () => supervisor.stop()
  })
}
