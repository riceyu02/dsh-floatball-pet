/**
 * Focus helper — a tiny local service that raises the DeepSeek Harness window.
 *
 * Why this exists: when Chromium's sandbox cannot initialise — which happens on
 * some locked-down machines, and always when the install path contains non-ASCII
 * characters — the app has to run with `--no-sandbox`, and that leaves the
 * process with a *restricted* token. A restricted token can neither enumerate
 * other processes nor compile the C# that window activation needs, and Windows
 * refuses it the WMI and shell escapes too — so the pet itself simply cannot
 * raise DSH's window.
 *
 * Something has to start this helper with a full token, and there are two such
 * places on purpose:
 *
 *   * `tools/launch.cjs` starts it *before* Electron, so it inherits the launcher's
 *     token — the best case, and the normal one when running from source.
 *   * the packaged app starts it itself (`dsh.startFocusAgent`), running Electron's
 *     own binary with `ELECTRON_RUN_AS_NODE=1`. A packaged build has no launcher at
 *     all, and without this the helper simply never existed — which is why clicking
 *     the ball did nothing at all in the shipped exe.
 *
 * Either way it is the same process, and the pet asks it to do the focusing over
 * loopback HTTP. It holds no privileges the launcher did not already have.
 *
 * Endpoints (all require the X-Pet-Token header):
 *   POST /focus     -> { ok: boolean }   raise the DSH window
 *   POST /shutdown  -> stops the helper
 *   GET  /health    -> { ok: true, pid }
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dsh = require('../src/dsh');

const stateDir = process.env.DSH_PET_STATE_DIR || path.join(__dirname, '..', 'tools', '.userdata');
const handshakeFile = path.join(stateDir, 'focus-agent.json');
const token = crypto.randomBytes(24).toString('hex');
const IDLE_EXIT_MS = 12 * 60 * 60 * 1000;
// Which pet instance this helper works for. The pet writes its own pid here when
// it starts us, and only that instance will adopt the handshake we write — so a
// leftover helper from an earlier run is retired instead of silently inherited.
const ownerPid = Number(process.env.DSH_PET_OWNER_PID) || null;

let lastUsed = Date.now();

/**
 * Exit if the pet that started us is gone.
 *
 * The helper is detached on purpose (it must outlive nothing, but it must not be
 * killed when Electron's process tree is torn down), which means a pet that is
 * force-quit leaves us running. Without this, that leftover would be adopted by
 * the next pet — and a helper started from some other context carries *that*
 * context' token, so the adopted helper cannot focus anything while the pet
 * reports it as healthy. Exiting with our owner removes that whole failure mode.
 */
function ownerGone() {
  if (!ownerPid) return false;
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else — still alive.
    return error.code !== 'EPERM';
  }
}

function removeHandshake() {
  try {
    fs.rmSync(handshakeFile, { force: true });
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Can this helper compile C#? Raising a window needs `Add-Type`, and `Add-Type`
 * compiles by spawning a temporary `csc.exe` — so on a machine (or in a process
 * tree) where creating child processes is refused, focusing fails with
 * `Access is denied` and looks like a window problem. Probed once, then reported
 * through `/health` so the pet can skip a helper that cannot possibly work.
 */
let capability = null;
function agentCapable() {
  if (capability !== null) return capability;
  try {
    const script = 'try { Add-Type -TypeDefinition "public static class AgentCap { public static int X() { return 1; } }" -ErrorAction Stop; "capable" } catch { "incapable" }';
    const encoded = Buffer.from(`${script}`, 'utf16le').toString('base64');
    const out = require('child_process').execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 30000, windowsHide: true, encoding: 'utf8' },
    );
    capability = String(out).includes('capable');
  } catch {
    capability = false;
  }
  return capability;
}

function reply(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const server = http.createServer((req, res) => {
  if (req.headers['x-pet-token'] !== token) {
    reply(res, 403, { ok: false, error: 'bad token' });
    return;
  }
  lastUsed = Date.now();

  if (req.method === 'GET' && req.url === '/health') {
    reply(res, 200, { ok: true, pid: process.pid, owner: ownerPid, capable: agentCapable() });
    return;
  }
  if (req.method === 'POST' && req.url === '/focus') {
    // Always the thorough path: it is the only one that both defeats Windows'
    // foreground lock and verifies the window really did come forward. The
    // reason travels back so the pet can tell "no window exists" (recoverable by
    // starting DSH again) from "the window refused to come forward".
    dsh.focusDshStrong()
      .then((ok) => reply(res, 200, { ok, reason: dsh.focusReason(), detail: dsh.focusDetail() }))
      .catch((error) => reply(res, 200, { ok: false, reason: 'error', error: error.message, detail: error.message }));
    return;
  }
  if (req.method === 'POST' && req.url === '/shutdown') {
    reply(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 60);
    return;
  }
  reply(res, 404, { ok: false, error: 'not found' });
});

server.on('error', (error) => {
  // Port in use or loopback unavailable: the pet degrades to its own attempts.
  process.stderr.write(`[focus-agent] ${error.message}\n`);
  process.exit(1);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(handshakeFile, JSON.stringify({ port, token, pid: process.pid, owner: ownerPid }));
  } catch (error) {
    process.stderr.write(`[focus-agent] cannot write handshake: ${error.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`[focus-agent] listening on 127.0.0.1:${port} (owner ${ownerPid || 'unknown'})\n`);
});

// Take the handshake file with us, so the pet is never offered a dead helper.
// A force-kill skips this, which is exactly why the pet also checks liveness.
function exitNow() {
  removeHandshake();
  process.exit(0);
}
process.on('exit', removeHandshake);
process.on('SIGINT', exitNow);
process.on('SIGTERM', exitNow);

setInterval(() => {
  if (Date.now() - lastUsed > IDLE_EXIT_MS) exitNow();
  if (ownerGone()) exitNow();
}, 60 * 1000).unref();
