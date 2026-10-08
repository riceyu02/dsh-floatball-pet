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

/**
 * Windows that cover the whole display without being "a game or a video in front of
 * you": the desktop itself, the taskbar, the Start menu, the alt-tab switcher and their
 * friends. Their rectangles are as large as a full-screen game's, so the rectangle test
 * alone would keep the pet tucked away after a Win-key press — measured report: "press
 * Win, open any window over a running game, and the ball never comes back".
 */
const SHELL_CLASSES = new Set([
  'progman', 'workerw', 'shell_traywnd', 'shell_secondarytraywnd',
  'windows.ui.core.corewindow', 'xamlexplorerhostislandwindow',
  'multitaskingviewframe', 'tasklistthumbnailwnd', 'tasklistwnd',
  'foregroundstaging', 'applicationmanager_desktopshellwindow',
  'start', 'searchpane', 'windows.internal.shell.tabproxywindow',
  'shell_inputswitchtoplevelwindow', 'shell_charmwindow', 'sysshadow',
  'edgeuiinputtopwndclass', 'narratorhelperwindow', 'taskSwitcherWnd'.toLowerCase(),
  'windowstrackingsystem', 'msctfime ui', 'default ime',
]);

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
      const shell32 = koffi.load('shell32.dll');
      const enumProc = koffi.proto('bool EnumWindowsProc(void *hwnd, void *param)');
      api = {
        source: candidate,
        koffi,
        getWindowLong: user32.func('long GetWindowLongA(void *h, int index)'),
        setWindowPos: user32.func('bool SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, unsigned int flags)'),
        getForegroundWindow: user32.func('void *GetForegroundWindow()'),
        getWindowRect: user32.func('bool GetWindowRect(void *h, _Out_ int *rect)'),
        getClassName: user32.func('int GetClassNameA(void *h, _Out_ char *buffer, int count)'),
        // Wide version on purpose: the ANSI one returns the local code page, which
        // turns Chinese window titles into mojibake.
        getWindowText: user32.func('int GetWindowTextW(void *h, _Out_ char *buffer, int count)'),
        getWindow: user32.func('void *GetWindow(void *h, unsigned int cmd)'),
        getTopWindow: user32.func('void *GetTopWindow(void *h)'),
        isWindow: user32.func('bool IsWindow(void *h)'),
        isWindowVisible: user32.func('bool IsWindowVisible(void *h)'),
        windowFromPoint: user32.func('void *WindowFromPoint(int x, int y)'),
        getWindowThreadProcessId: user32.func('unsigned int GetWindowThreadProcessId(void *h, _Out_ unsigned int *pid)'),
        enumWindows: user32.func('bool EnumWindows(EnumWindowsProc *callback, void *param)'),
        enumProc,
        // The call Windows itself makes before showing a notification: 3 means a
        // full-screen Direct3D application is running, which is as close to "a game is
        // on" as the system will tell anybody.
        queryUserNotificationState: shell32.func('int SHQueryUserNotificationState(_Out_ int *state)'),
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

/** Class name of a window handle, lower-cased; empty when it cannot be read. */
function classNameOf(hwnd) {
  const found = load();
  if (!found || hwnd === null) return '';
  const buffer = Buffer.alloc(256);
  const length = found.getClassName(hwnd, buffer, buffer.length);
  if (!length) return '';
  return buffer.toString('latin1', 0, length).toLowerCase();
}

/**
 * Is the foreground window an unrelated window covering that whole display?
 *
 * The usual "a game or a video is running full screen" test — rectangle covers the
 * display bounds (not merely its work area) — plus two exclusions that matter in
 * practice: our own window, and the Windows shell. The desktop, the taskbar, the Start
 * menu and the alt-tab switcher all report full-screen rectangles, so without the class
 * filter the pet would stay hidden after a Win-key press instead of coming back.
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds display to test against
 * @param {bigint|null} ownHwnd the pet's own window, never "full screen in front of us"
 * @returns {{covered:boolean, className:string, rect:number[]|null}} what it decided and why
 */
function foregroundFullscreen(bounds, ownHwnd) {
  const found = load();
  if (!found) return { covered: false, className: '', rect: null };
  const foreground = found.getForegroundWindow();
  if (!foreground || (ownHwnd !== null && foreground === ownHwnd)) {
    return { covered: false, className: '', rect: null };
  }
  const className = classNameOf(foreground);
  if (SHELL_CLASSES.has(className)) return { covered: false, className, rect: null };

  const rect = [0, 0, 0, 0];
  if (!found.getWindowRect(foreground, rect)) return { covered: false, className, rect: null };
  const [left, top, right, bottom] = rect;
  const tolerance = 2;
  const covered = left <= bounds.x + tolerance
    && top <= bounds.y + tolerance
    && right >= bounds.x + bounds.width - tolerance
    && bottom >= bounds.y + bounds.height - tolerance;
  return { covered, className, rect };
}

/** Kept for callers that only want the yes/no answer. */
function foregroundCovers(bounds, ownHwnd) {
  return foregroundFullscreen(bounds, ownHwnd).covered;
}

/* ------------------------------------------------------- windows and games ---- */

const GW_HWNDNEXT = 2;
/** `SHQueryUserNotificationState`: a full-screen Direct3D application is running. */
const STATE_D3D_FULLSCREEN = 3;

/** What Windows thinks is happening: 3 = a full-screen game, 5 = normal, null = unknown. */
function userNotificationState() {
  const found = load();
  if (!found) return null;
  const state = [0];
  return found.queryUserNotificationState(state) === 0 ? state[0] : null;
}

/** Is a full-screen Direct3D application (a game) running, according to Windows? */
function d3dFullscreenRunning() {
  return userNotificationState() === STATE_D3D_FULLSCREEN;
}

/** Process id that owns a window. */
function windowPid(hwnd) {
  const found = load();
  if (!found || !hwnd) return null;
  const pid = [0];
  found.getWindowThreadProcessId(hwnd, pid);
  return pid[0] || null;
}

/** Title of a window, or '' when it has none. */
function windowTitle(hwnd) {
  const found = load();
  if (!found || !hwnd) return '';
  const buffer = Buffer.alloc(1024); // UTF-16: 512 characters
  const length = found.getWindowText(hwnd, buffer, 512);
  return length ? buffer.toString('utf16le', 0, length * 2) : '';
}

function windowRect(hwnd) {
  const found = load();
  if (!found || !hwnd) return null;
  const rect = [0, 0, 0, 0];
  if (!found.getWindowRect(hwnd, rect)) return null;
  return { x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] };
}

/**
 * Walk the top-level windows in z-order (front to back) without a callback: koffi
 * callbacks through `EnumWindows` did not survive the trip, and `GetTopWindow` plus
 * `GetWindow(GW_HWNDNEXT)` needs nothing but plain calls.
 * @param {(hwnd: bigint) => boolean|void} visit return false to stop early
 */
function eachWindow(visit) {
  const found = load();
  if (!found) return;
  let hwnd = found.getTopWindow(null);
  let guard = 0;
  while (hwnd && guard < 3000) {
    guard += 1;
    if (visit(hwnd) === false) return;
    hwnd = found.getWindow(hwnd, GW_HWNDNEXT);
  }
}

/** Every visible top-level window with a title — what the settings picker lists. */
function listWindows() {
  const items = [];
  eachWindow((hwnd) => {
    const found = load();
    if (!found) return false;
    try {
      if (!found.isWindowVisible(hwnd)) return true;
      const title = windowTitle(hwnd);
      if (!title) return true;
      items.push({
        hwnd: String(hwnd),
        title,
        class: classNameOf(hwnd),
        pid: windowPid(hwnd),
        rect: windowRect(hwnd),
      });
    } catch { /* a window that vanished mid-enumeration */ }
    return true;
  });
  return items;
}

/**
 * The window the user would see at `point` if the pet's own window were not there.
 *
 * Walking down the z-order from our window instead of calling `WindowFromPoint` matters:
 * the pet is always-on-top, so the point belongs to the pet itself.
 */
function windowBelow(point, ownHwnd) {
  const found = load();
  if (!found) return null;
  const contains = (hwnd) => {
    const rect = windowRect(hwnd);
    return Boolean(rect)
      && point.x >= rect.x && point.x < rect.x + rect.width
      && point.y >= rect.y && point.y < rect.y + rect.height;
  };
  if (!ownHwnd) {
    const hit = found.windowFromPoint(point.x, point.y);
    return hit ? { hwnd: String(hit), pid: windowPid(hit), class: classNameOf(hit), title: windowTitle(hit) } : null;
  }
  let hwnd = found.getWindow(ownHwnd, GW_HWNDNEXT);
  let guard = 0;
  while (hwnd && guard < 400) {
    guard += 1;
    if (found.isWindowVisible(hwnd) && contains(hwnd)) {
      return { hwnd: String(hwnd), pid: windowPid(hwnd), class: classNameOf(hwnd), title: windowTitle(hwnd) };
    }
    hwnd = found.getWindow(hwnd, GW_HWNDNEXT);
  }
  return null;
}

/** Does a window of that process cover the whole display? (a full-screen game) */
function processCoversDisplay(pid, bounds) {
  const found = load();
  if (!found || !pid) return false;
  let covered = false;
  const tolerance = 2;
  eachWindow((hwnd) => {
    try {
      if (!found.isWindowVisible(hwnd)) return true;
      if (windowPid(hwnd) !== pid) return true;
      const rect = windowRect(hwnd);
      if (rect
        && rect.x <= bounds.x + tolerance && rect.y <= bounds.y + tolerance
        && rect.x + rect.width >= bounds.x + bounds.width - tolerance
        && rect.y + rect.height >= bounds.y + bounds.height - tolerance) {
        covered = true;
        return false;
      }
    } catch { /* ignore */ }
    return true;
  });
  return covered;
}

module.exports = {
  available,
  source,
  isTopmost,
  setTopmost,
  ensureTopmost,
  foregroundCovers,
  foregroundFullscreen,
  classNameOf,
  handleOf,
  userNotificationState,
  d3dFullscreenRunning,
  windowPid,
  windowTitle,
  windowRect,
  listWindows,
  windowBelow,
  processCoversDisplay,
};
