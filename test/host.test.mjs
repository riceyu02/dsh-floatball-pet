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
} from '../plugin/host.mjs'

test('derives DSH home and marks the helper as plugin-managed', () => {
  const profile = path.join('D:\\', '.dsh', 'profiles', 'desktop')
  assert.equal(resolveDshHome(profile, {}), path.join('D:\\', '.dsh'))
  const env = helperEnvironment({
    profileDir: profile,
    userDataDir: path.join(profile, 'data', 'dsh-desktop-pet'),
    hostPid: 123,
    noSandbox: true,
  }, {})
  assert.equal(env.DSH_PET_PLUGIN, '1')
  assert.equal(env.DSH_PET_PLUGIN_HOST_PID, '123')
  assert.equal(env.DSH_PET_NO_SANDBOX, '1')
  assert.equal(env.DSH_HOME, path.join('D:\\', '.dsh'))
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
