'use strict';
/**
 * The few Win32 calls the pet needs, when the machine already has a way to make them.
 *
 * Why this exists: everything Electron exposes for "keep me on top" goes through
 * Chromium's own cached window state, and on a layered, non-activatable window that
 * cache loses against anything else that rewrites the style. A tester measured the
 * sequence: `setAlwaysOnTop(false)` really clears `WS_EX_TOPMOST`, `setAlwaysOnTop(true)`
 * really sets it, and ~0.7 ms later the style is re-applied with the bit off again. The
 * same rewrite happens whenever we call `setIgnoreMouseEvents` for hover, which is what
 * makes the ball flicker between "on top" and "behind everything".
 *
 * Writing the bit with `SetWindowPos` bypasses all of it — but it has to happen often
 * (hover changes are user-paced), and shelling out to PowerShell for every check is far
 * too slow. So this loads koffi when the profile happens to carry one (it ships with
 * dsh-orb and with DSH itself) and stays silent when it does not: the caller keeps its
 * slower PowerShell fallback either way.
 *
 * Every method is a no-op when `available()` is false.
 */
const fs = require('node:fs');
const path = require('node:path');

const PROFILE = process.env.DSH_PROFILE_DIR
  || (process.env.DSH_PET_USER_DATA ? path.dirname(path.dirname(process.env.DSH_PET_USER_DATA)) : null);

/** Where a koffi build suitable for this Electron may live. Order is preference. */
const KOFFI_CANDIDATES = [
  PROFILE && path.join(PROFILE, 'node_modules', 'koffi'),
  PROFILE && path.join(PROFILE, 'node_modules', 'dsh-orb', 'node_modules', 'koffi'),
  PROFILE && path.join(PROFILE, 'node_modules', 'dsh-whale-widget', 'node_modules', 'koffi'),
].filter(Boolean);

const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x8;
const HWND_TOPMOST = -1n;
const HWND_NOTOPMOST = -2n;
const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SWP_NOACTIVATE = 0x10;
const FLAGS = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE;

let api = null;
let loaded = false;

function load() {
  if (loaded) return api;
  loaded = true;
  for (const candidate of KOFFI_CANDIDATES) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const koffi = require(candidate);
      const user32 = koffi.load('user32.dll');
      api = {
        source: candidate,
        getWindowLong: user32.func('long GetWindowLongA(void *h, int index)'),
        setWindowPos: user32.func('bool SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, unsigned int flags)'),
        getForegroundWindow: user32.func('void *GetForegroundWindow()'),
        getWindowRect: user32.func('bool GetWindowRect(void *h, _Out_ int *rect)'),
      };
      return api;
    } catch {
      // A build for a different runtime, a missing dependency: both mean "no native
      // path", which the caller already handles.
    }
  }
  return null;
}

/** Window handle from Electron's `win.getNativeWindowHandle()` buffer. */
function handleOf(buffer) {
  if (buffer.length >= 8) return buffer.readBigUInt64LE(0);
  return BigInt(buffer.readUInt32LE(0));
}

function available() {
  return load() !== null;
}

function source() {
  const found = load();
  return found ? found.source : null;
}

/** Is the real `WS_EX_TOPMOST` bit set? Electron's `isAlwaysOnTop()` cannot answer this. */
function isTopmost(hwnd) {
  const found = load();
  if (!found || hwnd === null) return false;
  return (found.getWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) !== 0;
}

/**
 * Write the topmost bit straight through.
 * @returns {boolean} true when the call went out.
 */
function setTopmost(hwnd, on = true) {
  const found = load();
  if (!found || hwnd === null) return false;
  return Boolean(found.setWindowPos(hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, FLAGS));
}

/** Set it only when it is actually missing — the common case costs one read. */
function ensureTopmost(hwnd) {
  if (isTopmost(hwnd)) return false;
  return setTopmost(hwnd, true);
}

/**
 * Is the foreground window an unrelated window covering that whole display?
 * The usual "a game or a video is running full screen" test: the rectangle covers the
 * display bounds, not merely its work area, and it is not our own window.
 */
function foregroundCovers(bounds, ownHwnd) {
  const found = load();
  if (!found) return false;
  const foreground = found.getForegroundWindow();
  if (!foreground || (ownHwnd !== null && foreground === ownHwnd)) return false;
  const rect = [0, 0, 0, 0];
  if (!found.getWindowRect(foreground, rect)) return false;
  const [left, top, right, bottom] = rect;
  const tolerance = 2;
  return left <= bounds.x + tolerance
    && top <= bounds.y + tolerance
    && right >= bounds.x + bounds.width - tolerance
    && bottom >= bounds.y + bounds.height - tolerance;
}

module.exports = { available, source, isTopmost, setTopmost, ensureTopmost, foregroundCovers, handleOf };
