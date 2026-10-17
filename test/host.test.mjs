import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PetSupervisor,
  helperEnvironment,
  resolveDshHome,
  resolveRuntime,
  selfSpec,
  tarballVersion,
} from '../plugin/host.mjs'

test('derives DSH home and marks the helper as plugin-managed', () => {
  const profile = path.join('D:\\', '.dsh', 'profiles', 'desktop')
  assert.equal(resolveDshHome(profile, {}), path.join('D:\\', '.dsh'))
  const env = helperEnvironment({
    profileDir: profile,
    userDataDir: path.join(profile, 'data', 'dsh-floatball-pet'),
    hostPid: 123,
    noSandbox: true,
  }, {})
  assert.equal(env.DSH_PET_PLUGIN, '1')
  assert.equal(env.DSH_PET_PLUGIN_HOST_PID, '123')
  assert.equal(env.DSH_PET_NO_SANDBOX, '1')
  assert.equal(env.DSH_HOME, path.join('D:\\', '.dsh'))
})

test('strips the Electron-as-Node switch inherited from the DSH host', () => {
  // Measured failure: with ELECTRON_RUN_AS_NODE=1 inherited, the helper runs as a plain
  // Node process — no window, empty log, exit code 0 — which reads as "no ball".
  const profile = path.join('D:\\', '.dsh', 'profiles', 'desktop')
  const env = helperEnvironment({
    profileDir: profile,
    userDataDir: path.join(profile, 'data', 'dsh-floatball-pet'),
    hostPid: 123,
  }, { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', PATH: 'inherited' })
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(env.ELECTRON_NO_ATTACH_CONSOLE, undefined)
  assert.equal(env.PATH, 'inherited')
  assert.equal(env.DSH_PET_PLUGIN, '1')
})

test('resolves both packed and source-checkout runtimes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-pet-runtime-'))
  try {
    const packed = path.join(root, 'runtime', 'DSH悬浮球.exe')
    const source = path.join(root, 'dist', 'DSH悬浮球', 'DSH悬浮球.exe')
    mkdirSync(path.dirname(source), { recursive: true })
    writeFileSync(source, '')
    assert.equal(resolveRuntime(root, {}), source)
    mkdirSync(path.dirname(packed), { recursive: true })
    writeFileSync(packed, '')
    assert.equal(resolveRuntime(root, {}), packed)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolves the version-keyed runtime cache written by prepare-install', () => {
  // `DSH_PET_RUNTIME_DIR` is the installer's override for the same directory. It is how
  // an upgrade finds a runtime assembled by an earlier version: nothing is downloaded
  // and nothing is assembled when the cache already holds the Electron version.
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-pet-cache-'))
  try {
    const cache = path.join(root, 'runtime')
    const versioned = path.join(cache, '33.4.11')
    mkdirSync(versioned, { recursive: true })
    const executable = path.join(versioned, 'DSH悬浮球.exe')
    writeFileSync(executable, '')
    const env = { DSH_PET_RUNTIME_DIR: cache }

    // Without the marker the directory is an interrupted assembly, not a runtime.
    assert.equal(resolveRuntime(root, env), null)

    writeFileSync(path.join(versioned, '.ready.json'), JSON.stringify({ electronVersion: '33.4.11' }))
    assert.equal(resolveRuntime(root, env), executable)

    // A runtime shipped inside the package still wins, so an install that carries one
    // never switches over to the cache.
    const packed = path.join(root, 'runtime', 'DSH悬浮球.exe')
    mkdirSync(path.dirname(packed), { recursive: true })
    writeFileSync(packed, '')
    assert.equal(resolveRuntime(root, env), packed)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts both the scoped and the unprefixed name a profile may use', () => {
  // npm installs use `dsh-floatball-pet`; the release tarballs are named without the
  // The project was renamed to `dsh-floatball-pet`; profiles installed under the old name
  // are still written that way. Both have to resolve, or an upgraded installation silently
  // loses the lookups that clean up old installers — that is what breaks when only one name
  // is accepted.
  assert.equal(selfSpec({ dependencies: { 'dsh-floatball-pet': 'file:a.tgz' } }), 'file:a.tgz')
  assert.equal(selfSpec({ dependencies: { 'dsh-desktop-pet': 'file:b.tgz' } }), 'file:b.tgz')
  assert.equal(selfSpec({ dependencies: { other: 'x' } }), null)
  assert.equal(selfSpec({}), null)

  // The release tarball name, under either name.
  assert.equal(tarballVersion('dsh-floatball-pet-0.1.0.tgz'), '0.1.0')
  assert.equal(tarballVersion('dsh-desktop-pet-0.1.0.tgz'), '0.1.0')
  assert.equal(tarballVersion('dsh-desktop-pet-0.2.20.tgz'), '0.2.20')
  assert.equal(tarballVersion('dsh-floatball-pet-1.10.3.tgz'), '1.10.3')
  // Anything that is not one of ours has no version at all.
  assert.equal(tarballVersion('dsh-orb-0.1.4.tgz'), null)
  assert.equal(tarballVersion('not-dsh-floatball-pet-1.0.0.tgz'), null)
  assert.equal(tarballVersion('dsh-floatball-pet-0.1.0.tgz.part'), null)
})

test('supervisor starts, retries an early sandbox failure, and stops the helper', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-pet-host-'))
  const runtimePath = path.join(root, 'DSH悬浮球.exe')
  writeFileSync(runtimePath, '')
  const calls = []
  const children = []
  const spawn = (file, args, options) => {
    const child = new EventEmitter()
    child.pid = 100 + children.length
    child.killed = false
    child.unref = () => {}
    child.kill = () => { child.killed = true }
    calls.push({ file, args, options })
    children.push(child)
    return child
  }
  try {
    const supervisor = new PetSupervisor({
      runtimePath,
      profileDir: path.join(root, 'profile'),
      userDataDir: path.join(root, 'profile', 'data'),
      hostPid: 77,
      platform: 'win32',
      spawn,
      retryDelayMs: 0,
    })
    assert.equal(supervisor.start(), true)
    assert.deepEqual(calls[0].args, [])
    assert.equal(calls[0].options.env.DSH_PET_PLUGIN, '1')
    children[0].emit('exit', 1, null)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].args, ['--no-sandbox'])
    assert.equal(calls[1].options.env.DSH_PET_NO_SANDBOX, '1')
    supervisor.stop()
    assert.equal(children[1].killed, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hands the DSH web origin to the helper so it can find DSH', () => {
  // The pet decides whether DSH is running by connecting to its web port, and reads the
  // uptime only once that succeeds. The port is ephemeral, so the address has to come
  // from the host that is listening on it; a guess shows up as 「未运行」 on a running DSH.
  const profile = path.join('D:\\', '.dsh', 'profiles', 'desktop')
  const env = helperEnvironment({
    profileDir: profile,
    userDataDir: path.join(profile, 'data', 'dsh-floatball-pet'),
    hostPid: 123,
    dshUrl: 'http://127.0.0.1:65064',
  }, {})
  assert.equal(env.DSH_WEB_URL, 'http://127.0.0.1:65064')

  // And when the server has not bound yet, the inherited value (if any) is kept rather
  // than replaced by undefined.
  const inherited = helperEnvironment({
    profileDir: profile,
    userDataDir: path.join(profile, 'data', 'dsh-floatball-pet'),
    hostPid: 123,
    dshUrl: null,
  }, { DSH_WEB_URL: 'http://127.0.0.1:1234' })
  assert.equal(inherited.DSH_WEB_URL, 'http://127.0.0.1:1234')
})

test('game process lists survive the trip to the helper environment', () => {
  const env = helperEnvironment({
    profileDir: 'C:\\profile',
    userDataDir: 'C:\\profile\\data',
    hostPid: 1,
    gameProcesses: ['EldenRing.exe', ' Game '],
    ignoreProcesses: ['mpv'],
  }, { PATH: 'x' })
  // Names are normalised once, where the config is read, so the pet can compare them
  // straight against the executable name it reads out of the window.
  assert.equal(env.DSH_PET_GAME_PROCESSES, 'eldenring,game')
  assert.equal(env.DSH_PET_IGNORE_PROCESSES, 'mpv')
  // And the two variables that used to make the ball never appear stay stripped.
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
})
