'use strict';
/**
 * DSH 悬浮球 (desktop pet) — Electron main process.
 *
 * One frameless, transparent, always-on-top window hosts the ball. The window is
 * click-through everywhere except the ball, the opened island and the settings
 * panel; this process decides which of those the cursor is over (see pollCursor)
 * and tells the renderer what to draw.
 */
const { app, BrowserWindow, ipcMain, screen, powerMonitor, dialog, Tray, Menu, nativeImage, shell } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

/**
 * DSH plugin mode is selected by the Cordis host wrapper.  The helper remains a
 * separate Electron process (transparent desktop windows do not belong inside
 * DSH's main BrowserWindow), but its lifetime and data directory are owned by
 * the DSH profile that launched it.
 */
const PLUGIN_MANAGED = process.env.DSH_PET_PLUGIN === '1';
const PLUGIN_HOST_PID = Number.parseInt(process.env.DSH_PET_PLUGIN_HOST_PID || '', 10);
const pluginUserData = process.env.DSH_PET_USER_DATA;
if (PLUGIN_MANAGED && pluginUserData) {
  const resolvedUserData = path.resolve(pluginUserData);
  fs.mkdirSync(resolvedUserData, { recursive: true });
  app.setPath('userData', resolvedUserData);
}

// Chromium watches for windows being covered and stops drawing the "occluded" ones.
// Turning the display off makes every window look occluded, and the tracker does not
// always come back cleanly — the window returns visible but stale or unresponsive.
// This window is a 56px toy that is meant to be on top of everything anyway, so the
// calculation buys nothing and costs correctness.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Chromium's sandbox cannot initialise on some machines (and always fails when the
// install path contains non-ASCII characters). That failure is silent — the process
// dies before any of our code runs — so this has to be decided before `ready`, and
// it is why the launchers pass `--no-sandbox` as a real command-line argument.
//
// This used to append the switch unconditionally when packaged. That was a mistake:
// the switch is only needed on machines where the sandbox cannot start, and it
// leaves the process with a *restricted* token that every child inherits. The focus
// helper is one of those children, and a restricted token cannot create the compiler
// child that `Add-Type` needs (`Access is denied`), so the helper silently could not
// focus anything. Now the switch is only added when the launcher (or the user) asked
// for it, or when DSH_PET_NO_SANDBOX is set explicitly — so a packaged build on a
// healthy machine keeps full privileges.
if (!process.argv.includes('--no-sandbox') && process.env.DSH_PET_NO_SANDBOX) {
  app.commandLine.appendSwitch('no-sandbox');
}

const dsh = require('./dsh');
const update = require('./update');
const win32 = require('./win32');
const { Store } = require('./store');
const { makeIconPng } = require('./icon');

/** Append-only boot/diagnostic log next to the preferences file. */
const LOG_FILE = path.join(app.getPath('userData'), 'pet.log');
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
    process.stdout.write(line);
  } catch {
    /* logging must never take the pet down */
  }
}
log('--- boot ---', `electron=${process.versions.electron}`, `pid=${process.pid}`);
process.on('uncaughtException', (error) => log('uncaughtException', error.stack || error.message));
process.on('unhandledRejection', (reason) => log('unhandledRejection', String(reason)));

/** Transparent margin kept inside the window on every side (room for the soft drop shadows). */
const PAD = 42;
/** Gap between the capsule and the settings panel above it. */
const PANEL_GAP = 12;
/** Ball diameter bounds, mirroring the slider in the settings panel. */
const MIN_SIZE = 40;
const MAX_SIZE = 96;
/**
 * Window-width allowance for the island, as a multiple of the ball diameter.
 * The renderer measures the real island and reports it back through
 * `pet:metrics`; this is only the value used before that first report and the
 * floor that keeps the first frames from clipping.
 */
const ISLAND_ALLOWANCE = 4.4;
/** Fallback settings-panel box used until the renderer reports its real one. */
/**
 * Panel size to assume before the renderer has measured one.
 *
 * The width mirrors what pet.js will report — the largest ball plus the island
 * that unfolds from it — so the window is built at its final size from the first
 * frame. It is also the hard ceiling for that measurement (`room`), which is why
 * the two numbers are the same.
 */
const PANEL_FALLBACK = { width: 326, height: 232, islandW: 0 };

const BALANCE_INTERVAL_MS = 5 * 60 * 1000;
const PROCESS_INTERVAL_MS = 15 * 1000;
// While DSH is not detected, poll fast: under the plugin the ball is started *during*
// DSH's boot, before its web port listens, so the first probes legitimately see
// nothing — on the slow interval that showed up as 「未运行」 for up to 15 seconds.
const PROCESS_FAST_INTERVAL_MS = 2 * 1000;
/** Cursor poll cadence for hover / click-through decisions. */
const CURSOR_POLL_MS = 40;
/**
 * Drag-follow cadence.
 *
 * Faster than the display refresh on purpose. A mouse reports its position
 * 125–1000 times a second while a 60 Hz display only samples the window position
 * once per frame; ticking at 16ms beat against the 16.7ms frame, so some frames
 * carried two stale samples and some carried none. Sampling well above the frame
 * rate means every frame sees the freshest position instead of an aliased one.
 */
const DRAG_TICK_MS = 8;

/**
 * One Euro filter settings for the drag position, in DIP and Hz.
 *
 * A resting hand still reports about a pixel of movement, and hardware reports
 * it many times per frame, so piping raw samples straight into the window makes
 * the ball buzz. A fixed dead zone stops the buzz but turns slow drags into a
 * series of jumps, which is its own kind of judder.
 *
 * The One Euro filter adapts instead: the cutoff rises with the estimated speed,
 * so a nearly-still pointer is smoothed hard (jitter disappears) while a fast
 * drag is passed through almost untouched (no rubber-band lag). It is the
 * standard answer to exactly this problem in pointer tracking.
 */
const SMOOTH_MIN_CUTOFF = 1.8;
const SMOOTH_BETA = 0.05;
// How fast the filter's own speed estimate is allowed to change. At 1 Hz (tau ~ 160ms)
// the cutoff could not rise until long after the pointer had already sped up — or
// reversed — so the ball trailed on every change of direction. 3 Hz (tau ~ 53ms)
// still ignores the sub-pixel noise that the estimate is meant to ignore, but keeps
// up with a hand.
const SMOOTH_DERIV_CUTOFF = 3.0;
// After the button comes up, keep following (and filtering) briefly so the ball
// closes any remaining gap by gliding instead of teleporting.
const DRAG_SETTLE_MS = 260;

function smoothingAlpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

let dragFilter = null;

function smoothPointer(x, y, now) {
  if (!dragFilter) {
    dragFilter = { x, y, dx: 0, dy: 0, t: now };
    return { x, y };
  }
  let dt = (now - dragFilter.t) / 1000;
  if (!(dt > 0)) dt = 1 / 120;
  dragFilter.t = now;

  const aDeriv = smoothingAlpha(SMOOTH_DERIV_CUTOFF, dt);
  dragFilter.dx += aDeriv * ((x - dragFilter.x) / dt - dragFilter.dx);
  dragFilter.dy += aDeriv * ((y - dragFilter.y) / dt - dragFilter.dy);

  const speed = Math.hypot(dragFilter.dx, dragFilter.dy);
  const a = smoothingAlpha(SMOOTH_MIN_CUTOFF + SMOOTH_BETA * speed, dt);
  dragFilter.x += a * (x - dragFilter.x);
  dragFilter.y += a * (y - dragFilter.y);
  return { x: dragFilter.x, y: dragFilter.y };
}
/**
 * How long the island and the settings panel survive after the pointer leaves
 * them, before both fold away together.
 *
 * Short on purpose: the interface should get out of the way once the pointer has
 * moved on. It is not zero because a single unlucky poll must not fold everything
 * away and immediately unfold it again.
 */
const IDLE_CLOSE_MS = 220;
/** Ball-size animation frame and the per-frame fraction closed each tick. */
const SIZE_TICK_MS = 8;
/**
 * Time constant of the size chase, in milliseconds. The ball covers ~63% of the
 * remaining distance every SIZE_TAU_MS, so a full-range resize settles in a bit
 * over a fifth of a second.
 */
const SIZE_TAU_MS = 85;
/** Slack added around the ball and island so hovering them feels forgiving. */
const HOVER_SLACK = 8;

const store = new Store(path.join(app.getPath('userData'), 'preferences.json'));

// DSH owns startup in plugin mode.  Ignore a legacy standalone preference so
// the helper never registers a second, independent Windows login entry.
if (PLUGIN_MANAGED) store.data.autoStart = false;

let win = null;
let tray = null;

/**
 * Ask Electron to keep the pet on top. The cheap half of the work — see the watchdog in
 * createWindow for the half that actually holds, and for why nothing here may ever call
 * `moveTop()` or `setAlwaysOnTop(false)`:
 *
 *   * `moveTop()` stacks this layered, non-activatable window at HWND_TOP, which drops
 *     it out of the topmost band (measured on 0.2.3: the ball surfaced for a moment and
 *     then sank behind the next activated window).
 *   * `setAlwaysOnTop(false)` clears WS_EX_TOPMOST for real, and on 0.2.4..0.2.6 the
 *     following `true` could not hold it — the style was re-applied ~0.7 ms later with
 *     the bit off, so the ball spent 0.026% of each cycle on top and the rest below
 *     every other window.
 *   * `win.isAlwaysOnTop()` reports Chromium's cached flag, never the real style.
 */
function assertOnTop() {
  if (!win || win.isDestroyed() || topmostSuppressed) return;
  win.setAlwaysOnTop(true, 'floating');
}

let metrics = { ...PANEL_FALLBACK };
let display = null;
let lastProbe = { running: false, seconds: null, startedAt: null, exePath: null };
let lastBalance = { amount: null, currency: 'CNY', source: 'pending', error: null };
let balanceTimer = null;
let processTimer = null;
let cursorTimer = null;
let sizeTimer = null;
// How often the always-on-top band is re-asserted; see the watchdog in createWindow.
const KEEP_ON_TOP_MS = 3000;
let keepOnTopTimer = null;
// How often the native guardian reads the real topmost bit. Hovering rewrites the
// window style, so this has to be well under a second to keep the ball from flickering.
const TOPMOST_GUARD_MS = 250;
// While the ball is in hand every frame moves and restyles the window.
const TOPMOST_GUARD_DRAG_MS = 60;
let topmostGuardTimer = null;
/** True while the pet is deliberately hidden because a game is in the way. */
let gameHidden = false;
/** True while a full-screen window is in front — the pet then deliberately stays behind it. */
let topmostSuppressed = false;
let lastSizeTick = 0;
let dragDirty = false;
/**
 * The diameter actually on screen. It chases `store.data.ballSize` a frame at a
 * time so the window bounds and the drawn ball can never disagree: animating the
 * size in CSS alone would leave the window already shrunk while the ball is still
 * large, which both clips it and drags its centre off the anchor point.
 */
let renderedSize = store.data.ballSize;

/* ------------------------------------------------- hover / click-through state */

/**
 * The window is a large transparent rectangle, but only the ball, the opened
 * island and the settings panel may swallow clicks. Electron's forwarded
 * mouse-move is not dependable on Windows, so the main process polls the cursor
 * and owns this state; the renderer only renders what it is told.
 */
let islandOpen = false;
let panelOpen = false;
let pointerInteractive = null;
let dragging = false;
let lastPollLog = 0;
let lastLoggedBounds = '';
let lastDisplayCheck = 0;
/** Cursor-to-ball-centre offset captured when a drag starts. */
let dragAnchor = null;
// While non-zero, the follow loop keeps running after release so the ball settles.
let dragSettleUntil = 0;
// Horizontal correction the renderer is applying to keep the ball where main put it.
let lastBallFix = 0;
let dragTimer = null;
let dragStartedAt = 0;
let pluginHostTimer = null;
/** Whether the island has already been retracted for the current drag. */
let dragRetracted = false;
/**
 * Window box last written to the window. Kept here so the per-frame drag loop does
 * not have to call getBounds() — a native round trip — a hundred times a second.
 */
let appliedBox = { x: NaN, y: NaN, width: NaN, height: NaN };
/**
 * Set once a drag has cleared the island away: hover must not immediately bring
 * it back, or it would pop open again the moment the ball is dropped. It clears
 * as soon as the pointer leaves the pet, so the next hover behaves normally.
 */
let hoverSuppressed = false;
/**
 * Which way the island opens, remembered between frames.
 *
 * Two reasons it is latched rather than recomputed every poll:
 *  * flipping while the ball is held makes the capsule, the settings panel and
 *    the whole window jump to the other side of the ball mid-drag;
 *  * right at the screen's midpoint the direction would otherwise oscillate on
 *    every frame. It only changes once the ball is clearly past the middle.
 */
let latchedSide = null;

/** How far past the midpoint the ball must go before the island swaps sides. */
const SIDE_HYSTERESIS = 80;

let outsideSince = 0;

/* ---------------------------------------------------------------- geometry */

/**
 * Work areas of every attached display, refreshed occasionally.
 *
 * Dragging is allowed anywhere inside any monitor's work area, so the pet can be
 * parked flush against a screen edge or a corner instead of stopping short of
 * it; the clamp only kicks in once the ball would leave every display. The list
 * is cached because the follow loop asks for it on every frame.
 */
let workAreas = [];
let workAreasAt = 0;
function currentWorkAreas() {
  const now = Date.now();
  if (!workAreas.length || now - workAreasAt > 500) {
    workAreas = screen.getAllDisplays().map((d) => d.workArea);
    workAreasAt = now;
  }
  return workAreas;
}

/**
 * Bounding box of every display's work area.
 *
 * Clamping against the union rather than one display at a time keeps dragging
 * across a monitor seam perfectly smooth, and insetting it by half the ball
 * means the ball is always wholly on screen: it can be parked flush against an
 * edge or a corner — detected and stopped there — but never hangs off or
 * disappears past the boundary.
 */
function workAreaUnion() {
  const areas = currentWorkAreas();
  if (!areas.length) return screen.getPrimaryDisplay().workArea;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const a of areas) {
    x1 = Math.min(x1, a.x);
    y1 = Math.min(y1, a.y);
    x2 = Math.max(x2, a.x + a.width);
    y2 = Math.max(y2, a.y + a.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function clampToDisplay(centerX, centerY) {
  // Clamp against the size the ball ACTUALLY has right now, never the size it is
  // growing towards.
  //
  // Using the target made the ball jump the instant a resize started: at the left
  // screen edge the ball sits at centre = size/2, and asking for a bigger ball
  // immediately demanded room for the FINAL diameter, shoving the whole UI inwards
  // before the ball had grown into that space — then it slid back out as the
  // animation caught up. Worse, it kept fighting `shiftCentreForSize`, which holds
  // the outer edge still by moving the centre by exactly half the size change: with
  // the live size those two agree to the pixel and neither has to move.
  const half = (renderedSize || store.data.ballSize) / 2;
  const area = workAreaUnion();
  const minX = area.x + half;
  const maxX = area.x + area.width - half;
  const minY = area.y + half;
  const maxY = area.y + area.height - half;
  return {
    centerX: Math.min(Math.max(centerX, minX), Math.max(minX, maxX)),
    centerY: Math.min(Math.max(centerY, minY), Math.max(minY, maxY)),
  };
}

function defaultCentre() {
  const area = screen.getPrimaryDisplay().workArea;
  return { centerX: area.x + 92, centerY: area.y + area.height - 92 };
}

/**
 * Island width the window must leave room for, in DIP.
 *
 * The renderer reports the island's measured width together with the ball size
 * it was measured at. While the ball animates, that measurement is scaled
 * linearly instead of asking the renderer again — everything in the island
 * (font size, paddings, gear) is a multiple of the ball diameter, so scaling
 * tracks it closely, and the exact value is reported again once it settles. The
 * extra few percent covers the `clamp()` in the font-size rule.
 */
function islandAllowance(size) {
  const measured = Math.round(metrics.islandW || 0);
  const base = Number(metrics.islandBaseSize) || 0;
  const estimate = Math.round(size * ISLAND_ALLOWANCE);
  if (!measured) return estimate;
  if (!base || Math.abs(size - base) < 0.5) return Math.max(measured, estimate);
  return Math.max(estimate, Math.round(measured * (size / base) * 1.04));
}

function computeLayout() {
  const size = renderedSize;
  const panelW = Math.max(200, Math.round(metrics.width || PANEL_FALLBACK.width));
  const panelBoxH = Math.max(0, Math.round(metrics.height || PANEL_FALLBACK.height));
  const panelReserve = panelBoxH + PANEL_GAP;

  // The window is sized for the largest ball and for the island or the settings
  // panel on EITHER side of it, and the ball sits at a fixed spot inside it.
  //
  // That last part is what stops the flash when the island swaps sides. When the
  // ball's place inside the window depended on the side, a flip changed two things
  // at once — the window's position (by ~366 DIP, sideways) and the ball's offset
  // within it — and those live in different processes. The window jumped
  // immediately while the stylesheet was still packing the ball the old way, so for
  // one frame the ball was drawn several hundred pixels away from itself: the
  // afterimage. With a fixed ball position the window's position no longer depends
  // on the side *or* on which way the panel faces, so a flip is pure CSS inside a
  // window that does not move at all.
  const frame = MAX_SIZE;
  // Room for the widest thing that ever sits beside the ball: the opened island, or
  // the settings panel which is as wide as the whole capsule. Pure constants, so the
  // window is built once and never resized.
  const room = Math.round(frame * ISLAND_ALLOWANCE);
  // Distance from the near window edge to the ball's OUTER edge — the edge the
  // settings panel lines up with, and the one the ball grows away from.
  //
  // Pinning the outer edge is what keeps the two flush at every diameter: the ball
  // grows inward, so its outer edge never leaves the panel's edge.
  //
  // It also means the ball's place inside the window depends on which way the island
  // unfolds, so swapping sides moves the window by `|mid - size|`, where `mid` is
  // whatever outer-edge offset the window was built around. That move is the one
  // thing here the user can actually see — the frame between the window moving and
  // the renderer adopting the new packing draws the ball that far off — so `mid` is
  // put in the middle of the size range rather than at the room boundary. Worst case
  // drops from 56 DIP to 28, and at the default 56px ball from 40 to 12.
  const midSize = Math.round((MIN_SIZE + MAX_SIZE) / 2);
  // width = edge + frame + PAD + room, and the offset is |width - 2*edge - size|,
  // which is zero at `midSize` when edge = frame + PAD + room - midSize.
  const edge = frame + PAD + room - midSize;
  const ballY = panelReserve + PAD;
  const width = edge + frame + PAD + room;
  const height = ballY + frame + PAD + panelReserve;

  const area = (display || screen.getPrimaryDisplay()).workArea;
  const centre = clampToDisplay(
    store.data.centerX ?? defaultCentre().centerX,
    store.data.centerY ?? defaultCentre().centerY,
  );
  store.data.centerX = centre.centerX;
  store.data.centerY = centre.centerY;

  // The side decides which way the island unfolds AND which edge of the ball is
  // pinned. It follows the ball directly, with a little hysteresis so a pet parked
  // on the midpoint cannot oscillate.
  const mid = area.x + area.width / 2;
  let side = latchedSide;
  if (!side) {
    side = centre.centerX > mid ? 'left' : 'right';
  } else if (centre.centerX > mid + SIDE_HYSTERESIS) {
    side = 'left';
  } else if (centre.centerX < mid - SIDE_HYSTERESIS) {
    side = 'right';
  }
  latchedSide = side;

  // A pet parked near the top shows its settings panel below the ball instead.
  const roomAbove = centre.centerY - size / 2 - PAD - panelReserve >= area.y;
  const panelBelow = !roomAbove;

  // The ball sits against its outer edge — the left one when the island unfolds
  // right, the right one when it unfolds left — so it grows inwards and its outer
  // edge never moves off the panel's edge.
  const orbLeft = side === 'right' ? edge : width - edge - size;
  const x = centre.centerX - size / 2 - orbLeft;
  const y = centre.centerY - size / 2 - ballY;

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    size,
    frame,
    room,
    edge,
    ballY,
    // The island's hover allowance, capped at the room actually reserved for it so
    // the hit box and the drawn island can never disagree.
    islandW: Math.min(islandAllowance(size), room),
    // How wide the island may unfold at all. The panel is as wide as the whole
    // capsule, i.e. this plus one ball, so both are bounded by `room` and the
    // window they live in never has to grow.
    islandMax: room - frame,
    side,
    panelBelow,
    orbLeft,
    orbTop: ballY,
    // Where the ball's left edge lands on screen once the window is placed there.
    // The renderer compares this against where the window actually is and shifts the
    // drawing if the window has not caught up yet — see `reconcileBallX` in pet.js.
    // Without it, the one layout change that genuinely moves the window (the island
    // swapping sides) paints a single frame with the ball packed the old way, which
    // reads as the ball flashing sideways.
    ballX: Math.round(x) + orbLeft,
  };
}

/**
 * Move the window, but never before the renderer has switched to the matching ball
 * packing.
 *
 * The ball's place inside the window depends on which way the island unfolds, so
 * swapping sides changes that place by `frame - size` while the window moves the
 * other way to keep the ball on screen. Those two travel by different routes — a
 * native `setBounds` here, a CSS variable in the renderer — and if the window moves
 * first, the frame in between draws the ball offset by the whole packing change,
 * which is exactly the sideways "flash" seen when a drag crosses the screen's
 * midline (and why a smaller ball flashes further: `frame - size` grows as the ball
 * shrinks).
 *
 * So: hand the renderer the new layout, hold the box until it confirms it is drawing
 * the new packing, then move. The timeout is a safety net so a lost message can
 * never freeze the pet in place.
 */
let packedOrbLeft = null;
let heldBox = null;
let heldTimer = null;

function commitWindowBox(box, layout) {
  if (!win || win.isDestroyed()) return;
  if (layout && layout.orbLeft !== packedOrbLeft) {
    packedOrbLeft = layout.orbLeft;
    if (!win.webContents.isDestroyed()) win.webContents.send('pet:layout', layout);
    heldBox = box;
    if (heldTimer) clearTimeout(heldTimer);
    heldTimer = setTimeout(releaseHeldBox, 150);
    return;
  }
  if (heldBox) { heldBox = box; return; }
  win.setBounds(box);
  reassertTopmostSoon();
}

function releaseHeldBox() {
  if (heldTimer) { clearTimeout(heldTimer); heldTimer = null; }
  const box = heldBox;
  heldBox = null;
  if (box && win && !win.isDestroyed()) { win.setBounds(box); reassertTopmostSoon(); }
}

/**
 * Put the topmost bit back right after something we did may have dropped it.
 *
 * Both moving the window and changing its click-through style make Chromium re-apply
 * the extended window style, and the topmost bit does not survive that. Measured
 * consequence while dragging the ball over another window: the bit is gone within a
 * frame or two of the move, and on 0.2.8 nothing noticed until the 15 s check — the ball
 * sank to the bottom a few seconds into the drag. A 250 ms guardian is still too slow
 * against a style rewrite that happens per frame, so every move re-asserts natively
 * (a read when the bit is fine; a write only when it is not) and checks once more 40 ms
 * later, which is after the deferred rewrite has landed.
 */
function reassertTopmostSoon() {
  if (!win32.available() || !win || win.isDestroyed() || topmostSuppressed) return;
  let handle;
  try {
    handle = win32.handleOf(win.getNativeWindowHandle());
  } catch {
    return;
  }
  win32.ensureTopmost(handle);
  const timer = setTimeout(() => {
    if (!win || win.isDestroyed() || topmostSuppressed) return;
    win32.ensureTopmost(handle);
  }, 40);
  timer.unref?.();
}

function applyLayout() {
  if (!win || win.isDestroyed()) return null;
  const layout = computeLayout();
  const box = { x: layout.x, y: layout.y, width: layout.width, height: layout.height };
  const bounds = win.getBounds();
  if (
    bounds.x !== box.x || bounds.y !== box.y ||
    bounds.width !== box.width || bounds.height !== box.height
  ) {
    commitWindowBox(box, layout);
  }
  appliedBox = box;
  return layout;
}

/* ------------------------------------------------------------------- data */

/**
 * Window-relative hit boxes (DIP) for the ball, the opened island and the panel.
 *
 * The ball is matched by its bounding square rather than its circle so the
 * corners of the visible ball still count as "on the ball", and the island and
 * panel are inflated a little, so the island does not snap shut the moment the
 * pointer grazes its edge.
 */
function hotspotRects(layout) {
  const { size, islandW, orbLeft, orbTop, width, height, side, panelBelow, frame } = layout;

  const ball = {
    x: orbLeft - HOVER_SLACK / 2,
    y: orbTop - HOVER_SLACK / 2,
    w: size + HOVER_SLACK,
    h: size + HOVER_SLACK,
  };
  const capLeft = side === 'right' ? orbLeft : orbLeft - islandW;
  const capsule = {
    x: capLeft - HOVER_SLACK,
    y: orbTop - HOVER_SLACK,
    w: size + islandW + HOVER_SLACK * 2,
    h: size + HOVER_SLACK * 2,
  };

  const panelW = Math.max(200, Math.round(metrics.width || PANEL_FALLBACK.width));
  const panelH = Math.max(0, Math.round(metrics.height || PANEL_FALLBACK.height));
  // Mirrors `.panel` / `.panel.below` in the stylesheet: flush with the ball's
  // outer edge — its left edge when the island unfolds right, its right edge when
  // it unfolds left. That edge is pinned, so the panel does not move when the ball
  // is resized and the two stay aligned at every diameter.
  const panel = {
    x: (side === 'right' ? orbLeft : orbLeft + size - panelW) - HOVER_SLACK,
    y: (panelBelow ? orbTop + size + PANEL_GAP : orbTop - PANEL_GAP - panelH) - HOVER_SLACK,
    w: panelW + HOVER_SLACK * 2,
    h: panelH + HOVER_SLACK * 2,
  };
  return { ball, capsule, panel, side, panelBelow };
}

function inside(x, y, box) {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

function pushHover() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:hover', { islandOpen, panelOpen });
  }
}

function applyPointerMode(interactive) {
  if (interactive === pointerInteractive || !win || win.isDestroyed()) return;
  pointerInteractive = interactive;
  win.setIgnoreMouseEvents(!interactive, { forward: true });
  // Changing the click-through style is the other rewrite that costs us the topmost
  // bit — hover in, hover out, drag start. See reassertTopmostSoon.
  reassertTopmostSoon();
}

/**
 * Put everything back the way it was after Windows has been through a state the pet
 * cannot observe.
 *
 * Turning the display off and on, locking the session, docking or changing
 * resolution can each leave the window visible and drawn but no longer behaving:
 * clicks and drags stop arriving, so the ball looks fine and does nothing. Rather
 * than guess which piece went stale, this re-asserts all of them — cheap, and only
 * ever runs on an event that means something already changed.
 */
let recovering = false;
function recoverAfterWake(reason) {
  if (recovering || !win || win.isDestroyed()) return;
  recovering = true;
  try {
    log('recover', reason);
    // Display geometry may be different now.
    workAreas = [];
    workAreasAt = 0;
    display = screen.getDisplayNearestPoint({
      x: Math.round(store.data.centerX ?? 0),
      y: Math.round(store.data.centerY ?? 0),
    });
    // The ball may now be off the screens entirely.
    const centre = clampToDisplay(store.data.centerX ?? 0, store.data.centerY ?? 0);
    store.data.centerX = centre.centerX;
    store.data.centerY = centre.centerY;

    // Re-assert stacking and visibility, without stealing focus. See assertOnTop for
    // why this is a toggle and why `moveTop` must not be used.
    assertOnTop();

    // Force one real resize so Chromium re-lays out and re-composites. A window whose
    // display was turned off can come back holding a stale surface.
    const box = appliedBox;
    if (Number.isFinite(box.width) && Number.isFinite(box.height)) {
      win.setBounds({ x: box.x, y: box.y, width: box.width + 1, height: box.height });
      win.setBounds(box);
      appliedBox = box;
    }

    // Make the next poll decide the pointer mode from scratch: the cached value may
    // say "click-through" while the pointer is sitting on the ball.
    pointerInteractive = null;
    applyPointerMode(false);

    applyLayout();
    push();
  } catch (error) {
    log('recover failed', reason, error.message);
  } finally {
    // Let a second event through shortly after: display changes arrive in bursts.
    setTimeout(() => { recovering = false; }, 400);
  }
}

/**
 * Electron's forwarded mouse-move events never arrive in every Windows
 * configuration, so hover and click-through are decided here from the real
 * cursor position instead of from the renderer.
 */
function pollCursor() {
  if (!win || win.isDestroyed()) return;
  try {
    pollCursorOnce();
  } catch (error) {
    // Never let one bad tick take the pet's only input path down with it: the poll
    // is what decides whether the window is click-through, so an exception thrown
    // before that leaves the ball visible but dead to clicks.
    if (!pollErrorLogged) {
      pollErrorLogged = true;
      log('poll failed', error.stack || error.message);
    }
  }
}

let pollErrorLogged = false;
let badPointerLogged = false;

function pollCursorOnce() {
  const pointer = screen.getCursorScreenPoint();
  // While the display is off, Windows hands back a sentinel instead of a position —
  // `-954437404` turned up in testing. Believing it says the pointer is nowhere near
  // the ball, the window is switched to click-through, and it stays that way once the
  // screen comes back: the ball is visible, but clicks, drags and the settings button
  // all do nothing. An implausible coordinate is therefore skipped rather than acted
  // on, which keeps the pointer mode exactly as it was until a real position arrives.
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)
    || Math.abs(pointer.x) > 1e6 || Math.abs(pointer.y) > 1e6) {
    if (!badPointerLogged) {
      badPointerLogged = true;
      log('poll', `ignoring implausible cursor position (${pointer.x},${pointer.y})`);
    }
    return;
  }
  badPointerLogged = false;
  const bounds = win.getBounds();
  const rects = hotspotRects(computeLayout());
  const x = pointer.x - bounds.x;
  const y = pointer.y - bounds.y;

  // Hovering anywhere on the ball or on the opened island keeps it open.
  const overBall = inside(x, y, rects.ball);
  const overCapsule = islandOpen && inside(x, y, rects.capsule);
  const overPanel = panelOpen && inside(x, y, rects.panel);
  const engaged = overBall || overCapsule || overPanel;

  const boundsKey = `${bounds.x},${bounds.y},${bounds.width}x${bounds.height},${renderedSize.toFixed(1)}`;
  const changed = boundsKey !== lastLoggedBounds;
  // Log on any geometry/state change, plus a slow heartbeat, so external tooling
  // always has a line whose numbers match the window that is really on screen.
  if (process.env.PET_DEBUG && (Date.now() - lastPollLog > 2000 || (changed && Date.now() - lastPollLog > 200))) {
    lastPollLog = Date.now();
    lastLoggedBounds = boundsKey;
    log('poll', `local=(${Math.round(x)},${Math.round(y)})`,
        `ball=(${Math.round(rects.ball.x)},${Math.round(rects.ball.y)},${Math.round(rects.ball.w)})`,
        `bounds=(${bounds.x},${bounds.y},${bounds.width}x${bounds.height})`,
        `size=${renderedSize.toFixed(1)}`,
        `pad=${PAD}`, `gap=${PANEL_GAP}`, `island=${Math.round(metrics.islandW || 0)}`,
        `panel=${Math.round(metrics.width || 0)}x${Math.round(metrics.height || 0)}`,
        `side=${rects.side}`, `below=${rects.panelBelow}`,
        `overBall=${overBall}`, `overCapsule=${overCapsule}`, `overPanel=${overPanel}`);
  }

  if (dragging) return;

  // "灵动岛常驻展开": the island is simply always there, no hover needed. Only the
  // island is affected — the settings panel still opens on the gear and folds away
  // when the pointer leaves. A drag still clears everything away (that runs through
  // its own path), and the end of the drag brings the island back.
  const pinned = store.data.islandPinned === true;
  if (pinned && !islandOpen && !hoverSuppressed) {
    islandOpen = true;
    pushHover();
  }

  // The settings panel and the island fold away in that order, never the other way
  // round. The island is what the panel hangs off, so collapsing it first left the
  // panel floating with nothing behind it — and the two had independent timers, so
  // that is exactly what happened on the way out.
  if (engaged) {
    outsideSince = 0;
    if (!islandOpen && !hoverSuppressed) {
      islandOpen = true;
      pushHover();
    }
  } else if (pinned && !panelOpen) {
    // Nothing to fold away: the island stays by request, and the panel is not up.
    outsideSince = 0;
  } else {
    // The pointer has left the pet: a fresh hover may open the island again.
    hoverSuppressed = false;

    if (islandOpen || panelOpen) {
      // One delay, and everything goes at once. The panel hangs off the island, so
      // closing them on separate timers left the panel floating on its own; and a
      // long idle delay just meant the interface sat there after the pointer had
      // moved on. The delay still exists so that one unlucky poll cannot fold
      // everything away and immediately unfold it again.
      if (!outsideSince) {
        outsideSince = Date.now();
      } else if (Date.now() - outsideSince > IDLE_CLOSE_MS) {
        outsideSince = 0;
        panelOpen = false;
        if (!pinned) islandOpen = false;
        pushHover();
      }
    }
  }

  applyPointerMode(overBall || overCapsule || overPanel);
}

function snapshot() {
  return {
    config: {
      ballSize: store.data.ballSize,
      opacity: store.data.opacity,
      autoStart: store.data.autoStart,
      islandPinned: store.data.islandPinned === true,
      ballImage: ballImageUrl(),
      showBalance: store.data.showBalance,
      showUptime: store.data.showUptime,
      managedByDsh: PLUGIN_MANAGED,
      gameMode: store.data.gameMode !== false,
      gameWindow: store.data.gameWindow || null,
    },
    update: {
      current: update.currentVersion(),
      last: update.lastResult(),
      // Installing for the user needs the profile and the CLI, which only exist when
      // DSH owns this process; standalone runs can still check and download by hand.
      auto: PLUGIN_MANAGED && Boolean(update.profileDir()),
    },
    layout: computeLayout(),
    hover: { islandOpen, panelOpen },
    data: {
      balance: lastBalance,
      dsh: {
        running: lastProbe.running,
        startedAt: lastProbe.startedAt,
        processes: lastProbe.processes || 0,
      },
    },
  };
}

function push() {
  if (win && !win.isDestroyed()) win.webContents.send('pet:snapshot', snapshot());
}

/**
 * Persist preferences shortly after the last change. Dragging a slider emits an
 * event per pixel of travel; writing the file synchronously for each one is both
 * pointless and visibly slow.
 */
let saveTimer = null;
function saveSoon(delay = 400) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; store.save(); }, delay);
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  store.save();
}

/** One animation frame of the ball-size chase. */
function stepSize() {
  // Ease by elapsed time, not by a fixed fraction per tick: a late or coalesced
  // tick then cannot make the ball jump, and the animation looks the same whether
  // the timer manages 60 or 120 steps a second.
  const now = Date.now();
  let dt = (now - lastSizeTick) / 1000;
  lastSizeTick = now;
  if (!(dt > 0) || dt > 0.25) dt = SIZE_TICK_MS / 1000;

  const target = store.data.ballSize;
  const diff = target - renderedSize;
  if (Math.abs(diff) <= 0.3) {
    shiftCentreForSize(target - renderedSize);
    renderedSize = target;
    // Clear the handle, not just the variable: leaving the interval running made
    // the app re-run a full layout plus two IPC pushes every 16ms for the rest of
    // the session, long after the ball had stopped moving.
    if (sizeTimer) { clearInterval(sizeTimer); sizeTimer = null; }
    pushSize(false, applyLayout());
    push();
    return;
  }
  const next = renderedSize + diff * (1 - Math.exp(-dt / (SIZE_TAU_MS / 1000)));
  shiftCentreForSize(next - renderedSize);
  renderedSize = next;
  pushSize(true, applyLayout());
}

/**
 * Keep the ball's anchored edges still while it changes size.
 *
 * The panel lines up with the ball's OUTER edge — its left when the island unfolds
 * right, its right when it unfolds left — and that edge is the anchor, so the ball
 * grows inwards and the panel's edge stays glued to it. Vertically the top edge is
 * the anchor, so the panel above stays put while the ball grows downwards.
 * The shift is reversible, so sliding the size back and forth returns the ball to
 * where it started.
 */
function shiftCentreForSize(delta) {
  if (!delta) return;
  const half = delta / 2;
  if (latchedSide === 'left') store.data.centerX -= half;
  else store.data.centerX += half;
  store.data.centerY += half;
}

function startSizeAnimation() {
  if (sizeTimer) return;
  lastSizeTick = Date.now();
  sizeTimer = setInterval(stepSize, SIZE_TICK_MS);
}

/**
 * @param {boolean} resizing true while the size chase is still running.
 * @param {object} [layout] the layout this frame was built from, so the renderer can
 *   verify the ball is drawn where main put it (see `reconcileBallX` in pet.js).
 */
function pushSize(resizing, layout) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:size', {
      size: renderedSize,
      resizing,
      ballX: layout ? layout.ballX : undefined,
      orbLeft: layout ? layout.orbLeft : undefined,
    });
  }
}

async function refreshBalance() {
  try {
    lastBalance = await dsh.readBalance();
  } catch (error) {
    lastBalance = { amount: null, currency: 'CNY', source: 'error', error: error.message };
  }
  push();
}

async function refreshProcess() {
  try {
    lastProbe = await dsh.probeDsh();
    if (process.env.PET_DEBUG) {
      log('probe', `running=${lastProbe.running}`, `processes=${lastProbe.processes || 0}`,
          `seconds=${lastProbe.seconds}`, `port=${lastProbe.port}`,
          `exe=${lastProbe.exePath || '-'}`);
    }
  } catch (error) {
    log('probe failed', error.message);
    lastProbe = { running: false, processes: 0, seconds: null, startedAt: null, exePath: null };
  }
  push();
}

/**
 * Debug-only loopback control endpoint, enabled with PET_DEBUG=1.
 *
 * It exists so the hover / click-through / size-animation behaviour can be
 * driven from a test script without fighting over the real cursor, and it is
 * never started in a normal run. Bound to 127.0.0.1 on an ephemeral port; the
 * port is written to `<userData>/debug-port` for the caller to read.
 */
function startDebugServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (body) => {
      const text = JSON.stringify(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(text);
    };
    if (url.pathname === '/size') {
      const value = Number(url.searchParams.get('v'));
      if (Number.isFinite(value)) {
        store.save({ ballSize: Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(value))) });
        startSizeAnimation();
      }
      json({ ok: true, target: store.data.ballSize, rendered: renderedSize });
      return;
    }
    if (url.pathname === '/move') {
      const centre = clampToDisplay(
        Number(url.searchParams.get('x')) || 0,
        Number(url.searchParams.get('y')) || 0,
      );
      store.data.centerX = centre.centerX;
      store.data.centerY = centre.centerY;
      saveSoon();
      applyLayout();
      push();
      json({ ok: true, centre });
      return;
    }
    if (url.pathname === '/state') {
      const layout = computeLayout();
      json({
        size: renderedSize,
        target: store.data.ballSize,
        centre: { x: Math.round(store.data.centerX), y: Math.round(store.data.centerY) },
        bounds: win && !win.isDestroyed() ? win.getBounds() : null,
        islandW: metrics.islandW || 0,
        islandBase: metrics.islandBaseSize || 0,
        islandAllow: islandAllowance(layout.frame),
        panelW: metrics.width || 0,
        panelH: metrics.height || 0,
        islandOpen,
        panelOpen,
        // Non-zero only while the renderer is correcting for a window move it has
        // not seen yet — i.e. for a frame or two around an island side swap.
        ballFix: lastBallFix,
        islandPinned: store.data.islandPinned === true,
        ballImage: ballImageUrl(),
        domProbe: lastDomProbe,
        hoverSuppressed,
        side: layout.side,
        panelBelow: layout.panelBelow,
        frame: layout.frame,
        room: layout.room,
        ballCx: layout.orbLeft + layout.size / 2,
        ballY: layout.ballY,
        ballEdge: layout.edge,
        orbLeft: layout.orbLeft,
        orbTop: layout.orbTop,
        layoutBox: { w: layout.width, h: layout.height, x: layout.x, y: layout.y },
        dragging,
        workAreas: currentWorkAreas(),
      });
      return;
    }
    if (url.pathname === '/hover') {
      islandOpen = url.searchParams.get('open') === '1';
      panelOpen = url.searchParams.get('panel') === '1';
      pushHover();
      json({ ok: true, islandOpen, panelOpen });
      return;
    }
    if (url.pathname === '/recover') {
      // Drive the same path a display wake-up or session unlock takes, so it can be
      // exercised without actually turning the monitor off.
      recoverAfterWake(url.searchParams.get('why') || 'debug');
      json({ ok: true, reason: 'recovering' });
      return;
    }
    if (url.pathname === '/quit') {
      json({ ok: true });
      setTimeout(() => app.quit(), 50);
      return;
    }
    res.writeHead(404).end();
  });
  server.on('error', (error) => log('debug server failed', error.message));
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    log('debug control on 127.0.0.1:' + port);
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), 'debug-port'), String(port));
    } catch { /* ignore */ }
  });
}

/* ----------------------------------------------------------------- window */

function createWindow() {
  const layout = computeLayout();
  win = new BrowserWindow({
    x: layout.x,
    y: layout.y,
    width: layout.width,
    height: layout.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    roundedCorners: false,
    // Never take the keyboard focus. Clicking a 56px toy must not pull the
    // foreground away from whatever the user was actually working in — and when
    // DSH is already in front it is exactly that steal, followed by handing focus
    // back, that makes Windows blink its taskbar button red.
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Not setAlwaysOnTop alone: the constructor option may not have reached Win32, and a
  // cached "already on top" makes the plain call a no-op. See assertOnTop.
  assertOnTop();
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { debug: process.env.PET_DEBUG ? '1' : '0' },
  });
  win.webContents.on('console-message', (_event, _level, message) => log('[renderer]', message));
  win.webContents.on('did-finish-load', () => log('renderer loaded'));
  win.webContents.on('did-fail-load', (_e, code, desc) => log('renderer failed', code, desc));
  win.webContents.on('render-process-gone', (_e, details) => log('renderer gone', JSON.stringify(details)));
  win.once('ready-to-show', () => {
    win.showInactive();
    log('window shown', JSON.stringify(win.getBounds()));
    // The renderer owns the real panel box; the first snapshot settles geometry.
    win.webContents.send('pet:snapshot', snapshot());
  });

  // Windows drops a topmost window out of the topmost band when something else takes
  // the foreground — another always-on-top window, a full-screen app, or a shell
  // utility that manages z-order. Nothing notifies us, so re-assert on a slow timer.
  //
  // The JS call here is the cheap half: it costs nothing and is correct whenever
  // Chromium's cached "always on top" is false. It is NOT enough on its own — a
  // tester's microsecond trace on 0.2.4..0.2.6 showed that everything Electron does
  // through setAlwaysOnTop gets undone: `false` clears WS_EX_TOPMOST for real, and
  // `true` does set it but the style is re-applied ~0.7 ms later with the bit off.
  // So every fifth tick also reads the real window style through the native helper and
  // puts the bit back only when it is actually missing.
  assertOnTop();
  let keepOnTopTicks = 0;
  const enforceTopmost = async () => {
    if (!win || win.isDestroyed() || topmostSuppressed) return;
    try {
      const handle = win.getNativeWindowHandle();
      const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
      const result = await dsh.ensureTopmost(hwnd.toString());
      if (result === 'fixed') log('topmost was missing — restored through SetWindowPos');
    } catch (error) {
      log('topmost check failed', error.message);
    }
  };

  // The native guardian. Hovering changes the mouse-pass-through style, and Chromium
  // re-applies the whole extended style when it does — which is what clears the topmost
  // bit and makes the ball flicker. Catching that needs a check a few times a second,
  // which only an in-process call can afford; koffi makes it possible, and when it is
  // not there the 15 s PowerShell net above is all we have.
  if (win32.available()) {
    log('topmost guardian active via', win32.source());
    const guardTick = () => {
      if (!win || win.isDestroyed()) { topmostGuardTimer = null; return; }
      let handle;
      try {
        handle = win32.handleOf(win.getNativeWindowHandle());
      } catch {
        topmostGuardTimer = setTimeout(guardTick, TOPMOST_GUARD_MS);
        topmostGuardTimer.unref?.();
        return;
      }
      const bounds = screen.getDisplayNearestPoint({
        x: Math.round(store.data.centerX || 0),
        y: Math.round(store.data.centerY || 0),
      }).bounds;
      // Game handling, in the three cases the user asked for:
      //
      //  1. No game around: the pet is simply always on top — a maximised or even a
      //     full-screen *ordinary* window is not a reason to hide (that was the old
      //     rule, and it made the ball vanish behind a full-screen browser).
      //  2. A windowed game is marked: the pet stays on top of ordinary windows, but
      //     gets out of the game's way — while the game is the window actually in front
      //     at the ball's position, the ball hides. Move another window over the game
      //     and the ball is visible again on top of it; move that window away and the
      //     ball hides again, because the game is back in front.
      //  3. A full-screen game: Windows reports it (a full-screen D3D application), or
      //     the marked game covers the display — then the ball stays hidden no matter
      //     what else is opened.
      const enabled = store.data.gameMode !== false;
      const marked = enabled && store.data.gameWindow ? store.data.gameWindow : null;
      const fullscreenGame = enabled
        && (win32.d3dFullscreenRunning() || (marked && win32.processCoversDisplay(marked.pid, bounds)));
      const centre = {
        x: Math.round(store.data.centerX || 0),
        y: Math.round(store.data.centerY || 0),
      };
      let reason = null;
      if (fullscreenGame) reason = 'full-screen game';
      else if (marked) {
        const beneath = win32.windowBelow(centre, handle);
        if (beneath && beneath.pid === marked.pid) reason = `game window in front (${beneath.title.slice(0, 40)})`;
      }

      if (reason) {
        if (!gameHidden) {
          gameHidden = true;
          log('hiding for the game:', reason);
          win.hide();
        }
        topmostGuardTimer = setTimeout(guardTick, dragging ? TOPMOST_GUARD_DRAG_MS : TOPMOST_GUARD_MS);
        topmostGuardTimer.unref?.();
        return;
      }
      if (gameHidden) {
        gameHidden = false;
        log('game no longer in front — showing the ball again');
        win.showInactive();
      }
      win32.ensureTopmost(handle);
      // Dragging moves and restyles the window on every frame, so the bit needs a much
      // tighter loop than when the pet is sitting still.
      topmostGuardTimer = setTimeout(guardTick, dragging ? TOPMOST_GUARD_DRAG_MS : TOPMOST_GUARD_MS);
      topmostGuardTimer.unref?.();
    };
    topmostGuardTimer = setTimeout(guardTick, TOPMOST_GUARD_MS);
    topmostGuardTimer.unref?.();
  } else {
    log('koffi not available — topmost keeps the slow native check only');
  }
  keepOnTopTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    assertOnTop();
    keepOnTopTicks += 1;
    if (keepOnTopTicks % 5 === 0) enforceTopmost();
  }, KEEP_ON_TOP_MS);
  keepOnTopTimer.unref?.();

  // Old installers are a whole Electron runtime each (113 MB) sitting in the profile
  // people back up, and cleaning up on every start also covers installs done by hand
  // rather than through the panel. Delayed so it never competes with drawing the ball.
  const cleanupTimer = setTimeout(() => {
    try {
      const result = update.cleanupOldTarballs();
      if (result.removed.length) log('removed old installers:', result.removed.join(', '));
    } catch (error) {
      log('installer cleanup failed', error.message);
    }
  }, 12 * 1000);
  cleanupTimer.unref?.();

  win.on('closed', () => { win = null; });

  // Keep the pet reachable when displays change.
  screen.on('display-metrics-changed', () => {
    display = screen.getDisplayNearestPoint({
      x: Math.round(store.data.centerX || 0),
      y: Math.round(store.data.centerY || 0),
    });
    applyLayout();
    push();
  });
}

function createTray() {
  const icon = nativeImage.createFromBuffer(makeIconPng(64)).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('DSH 悬浮球');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 置顶悬浮球', click: () => { if (win) { win.showInactive(); assertOnTop(); } } },
    { label: '打开 DeepSeek Harness', click: () => { dsh.openDsh(lastProbe).then(push); } },
    { type: 'separator' },
    {
      label: '悬浮球大小',
      submenu: [40, 48, 56, 64, 72, 84, 96].map((size) => ({
        label: `${size} px`,
        type: 'radio',
        checked: store.data.ballSize === size,
        click: () => { store.save({ ballSize: size }); applyLayout(); push(); },
      })),
    },
    { type: 'separator' },
    { label: PLUGIN_MANAGED ? '本次关闭悬浮球' : '退出', click: () => app.quit() },
  ]));
  tray.on('click', () => { if (win) { win.showInactive(); assertOnTop(); } });
}

function applyAutoStart(enabled) {
  if (PLUGIN_MANAGED) return;
  if (process.platform !== 'win32') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: app.isPackaged ? [] : [path.resolve(__dirname, '..')],
    });
  } catch (error) {
    console.error('[pet] auto-start failed:', error.message);
  }
}

/* -------------------------------------------------------------------- IPC */

/**
 * Dragging is driven from here, not from the renderer.
 *
 * Following the pointer through renderer `mousemove` events does not work: a
 * mouse reports far faster than a big transparent window can be repositioned, so
 * the window fell progressively behind — the ball drifted away from the pointer,
 * and once the pointer was off the ball the cursor flickered between grab and
 * arrow. The main process already polls the real cursor every frame for hover,
 * so it may as well move the window too: that is one `getCursorScreenPoint` plus
 * at most one `setPosition` per frame, with no IPC in the loop at all.
 */
function startDragFollow() {
  if (dragTimer) return;
  const pointer = screen.getCursorScreenPoint();
  dragAnchor = {
    dx: store.data.centerX - pointer.x,
    dy: store.data.centerY - pointer.y,
  };
  dragRetracted = false;
  dragFilter = null;
  dragStartedAt = Date.now();
  dragTimer = setInterval(stepDragFollow, DRAG_TICK_MS);
}

function stopDragFollow(settle = false) {
  if (settle && dragTimer) {
    // Let the filter close the remaining distance over the next few frames. Jumping
    // straight to the raw pointer instead is what made the ball "flash" to the
    // cursor on release: whatever the filter was trailing by at that instant became
    // a visible teleport.
    dragSettleUntil = Date.now() + DRAG_SETTLE_MS;
    return;
  }
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  dragAnchor = null;
  dragFilter = null;
  dragSettleUntil = 0;
}

/**
 * @param {boolean} force unused by the motion itself; kept so callers read clearly.
 */
function stepDragFollow(force = false) {
  if (!dragAnchor || !win || win.isDestroyed()) return;
  // Safety net: if the release event never arrives (focus stolen mid-drag), the
  // follow loop must not hold the ball hostage forever.
  if (dragStartedAt && Date.now() - dragStartedAt > 60000) {
    dragging = false;
    stopDragFollow();
    return;
  }
  const raw = screen.getCursorScreenPoint();
  // Always the filtered position — including on the final step. The old code used the
  // raw pointer on release, which threw away the filter's state and snapped the ball
  // onto the cursor by however much it had been trailing.
  const pointer = smoothPointer(raw.x, raw.y, Date.now());
  const centre = clampToDisplay(pointer.x + dragAnchor.dx, pointer.y + dragAnchor.dy);
  store.data.centerX = centre.centerX;
  store.data.centerY = centre.centerY;
  dragDirty = true;

  const now = Date.now();
  if (now - lastDisplayCheck > 300) {
    lastDisplayCheck = now;
    display = screen.getDisplayNearestPoint({
      x: Math.round(centre.centerX),
      y: Math.round(centre.centerY),
    });
  }

  const layout = computeLayout();
  const box = {
    x: Math.round(layout.x),
    y: Math.round(layout.y),
    width: Math.round(layout.width),
    height: Math.round(layout.height),
  };
  // Compare against the box we last applied rather than asking the window:
  // getBounds() is a native round trip and this runs over a hundred times a second.
  //
  // setBounds rather than setPosition even though only the position changes:
  // setPosition on a transparent Windows window quietly drifts the width (measured
  // 180 -> 211 DIP over one drag), and the window is a fixed size anyway, so
  // re-asserting the whole box costs nothing.
  if (appliedBox.x !== box.x || appliedBox.y !== box.y
    || appliedBox.width !== box.width || appliedBox.height !== box.height) {
    appliedBox = box;
    commitWindowBox(box, layout);
  }

  // Settling after release: stop as soon as the ball has caught up with the pointer,
  // or when the settle window runs out — whichever comes first.
  if (dragSettleUntil) {
    const gap = Math.hypot(raw.x - pointer.x, raw.y - pointer.y);
    if (gap < 0.5 || Date.now() >= dragSettleUntil) stopDragFollow();
  }
}

/**
 * What kind of image is this file, judged by its bytes rather than its name?
 *
 * The picker accepts a path from the user and the renderer then points an `<img>` at
 * it, so a wrong guess shows up as a broken ball. Reading the magic number also means
 * a correctly-renamed file still works and a video with a .png extension does not.
 *
 * @returns {'png'|'jpeg'|'gif'|'webp'|'bmp'|null}
 */
/**
 * Keep one of the three proportion multipliers inside a sane range.
 *
 * They scale parts of the island, and the island's width is measured and fed back
 * into the window geometry — so a value of 40 from a hand-edited preference file
 * would ask for a window far larger than any screen.
 */
function clampScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.5, Math.round(n * 100) / 100));
}

function sniffImage(file) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    head = Buffer.alloc(16);
    const read = fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    if (read < 12) return null;
  } catch {
    return null;
  }
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'bmp';
  return null;
}

/**
 * The custom ball image as a URL the renderer can use, or null for the built-in art.
 *
 * The file is referenced where it lives rather than copied, so a picture the user
 * later moves or deletes simply falls back to the built-in art instead of leaving a
 * broken ball behind. Re-checking the magic number here (not only when the file was
 * picked) means the same is true of a preference that was edited by hand — and the
 * result is cached per path, so this costs one stat per snapshot and one read per
 * change of picture.
 */
let ballImageCache = { path: undefined, url: null };

/** Debug only: the last DOM report from the renderer, surfaced through /state. */
let lastDomProbe = null;

function ballImageUrl() {
  const file = store.data.ballImage || null;
  if (file === ballImageCache.path) return ballImageCache.url;
  let url = null;
  try {
    if (file && fs.statSync(file).isFile() && sniffImage(file)) {
      url = pathToFileURL(file).href;
    }
  } catch {
    url = null;
  }
  ballImageCache = { path: file, url };
  return url;
}

function registerIpc() {
  ipcMain.on('pet:probe', (_event, data) => {
    // Debug only: whatever the renderer wants to report about its own DOM.
    // Named apart from `lastProbe`, which is the DeepSeek Harness process probe.
    if (process.env.PET_DEBUG) lastDomProbe = data;
  });

  ipcMain.handle('pet:pick-ball-image', async () => {
    // Deliberately no parent window: the pet is `focusable: false`, and a dialog
    // owned by a window that cannot take focus is a dialog the user cannot answer.
    const picked = await dialog.showOpenDialog({
      title: '选择悬浮球图标',
      buttonLabel: '用它',
      properties: ['openFile'],
      filters: [
        { name: '图片与动图 (PNG / JPG / GIF / WebP / BMP)', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    const file = picked.filePaths[0];
    const kind = sniffImage(file);
    if (!kind) return { ok: false, detail: '这个文件不是能显示的图片（支持 PNG / JPG / GIF / WebP / BMP）' };
    store.data.ballImage = file;
    saveSoon(0);
    push();
    log('ball image', kind, file);
    return { ok: true, kind, name: path.basename(file), url: pathToFileURL(file).href };
  });

  ipcMain.handle('pet:clear-ball-image', () => {
    store.data.ballImage = null;
    saveSoon(0);
    push();
    return { ok: true };
  });

  ipcMain.handle('pet:ready', () => snapshot());

  ipcMain.handle('pet:refresh', async () => {
    await Promise.all([refreshBalance(), refreshProcess()]);
    return snapshot();
  });

  /**
   * Windows the user can mark as "the game". Nothing in Windows says which window is a
   * game, so for a windowed one this list is the only honest answer; a full-screen D3D
   * game needs no marking at all (see the guardian in createWindow).
   */
  ipcMain.handle('pet:list-windows', () => {
    if (!win32.available()) return { ok: false, error: '这台机器上没有可用的原生接口（koffi）' };
    try {
      const windows = win32.listWindows()
        .filter((entry) => entry.rect && entry.rect.width > 200 && entry.rect.height > 150)
        .map(({ hwnd, title, pid, class: cls, rect }) => ({ hwnd, title, pid, class: cls, rect }));
      return { ok: true, windows };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('pet:set-game-window', (_event, target) => {
    const next = target && Number.isFinite(target.pid)
      ? { pid: target.pid, title: String(target.title || '').slice(0, 120), class: String(target.class || '') }
      : null;
    store.save({ gameWindow: next });
    log(next ? `game window marked: ${next.title} (pid ${next.pid})` : 'game window marker cleared');
    push();
    return { ok: true, gameWindow: next };
  });

  /** Ask GitHub whether a newer release exists. Resolves with the answer or the reason. */
  ipcMain.handle('pet:update-check', async () => {    try {
      return { ok: true, ...(await update.checkLatest()) };
    } catch (error) {
      log('update check failed', error.message);
      return { ok: false, current: update.currentVersion(), error: error.message };
    }
  });

  /**
   * Stage the new release and hand the install to a detached script, then quit: the
   * helper's own executable sits inside the package pnpm has to replace, so nothing
   * can be replaced while this process lives.
   */
  ipcMain.handle('pet:update-apply', async (_event, release) => {
    try {
      // The focus helper is a detached process running this package's own executable, so
      // it keeps runtime\ locked after this process exits. Stopping it here is what lets
      // the installer's wait finish in a second or two instead of timing out — and the
      // installer refuses to install while anything out of the package is still alive,
      // because a half-replaced package is a profile DSH cannot boot from.
      try {
        await dsh.stopFocusAgent();
        log('focus helper stopped for the update');
      } catch (error) {
        log('could not stop the focus helper', error.message);
      }
      const staged = await update.stageAndApply(release, lastProbe.exePath);
      log('update staged', staged.version, staged.tarball);
      setTimeout(() => app.quit(), 1200);
      return { ok: true, using: staged.version, via: 'restart' };
    } catch (error) {
      log('update apply failed', error.message);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('pet:open-dsh', async () => {
    // Decide on a fresh probe, not the cached one: the cached value can be up to
    // PROBE_INTERVAL_MS old, and acting on a stale "not running" makes the click
    // start a second DSH instead of raising the one already there — which is the
    // one outcome this whole path exists to avoid. It costs one TCP connect.
    let probe = lastProbe;
    try {
      probe = await dsh.probeDsh();
      lastProbe = probe;
    } catch {
      /* fall back to the cached probe */
    }
    const result = await dsh.openDsh(probe);
    log('open-dsh ->', result.action, result.detail || '',
        `(probe running=${probe.running} exe=${probe.exePath || '-'})`);
    // Clicking the ball must never strand keyboard focus on a 56px toy: when DSH
    // did not take the foreground, hand it back to whatever had it before.
    if (result.action !== 'focused' && win && !win.isDestroyed()) win.blur();
    setTimeout(refreshProcess, 1200);
    return result;
  });

  ipcMain.on('pet:set-panel', (_event, open) => {
    const next = Boolean(open);
    if (next === panelOpen) return;
    panelOpen = next;
    outsideSince = 0;
    if (next) islandOpen = true;
    pushHover();
  });

  ipcMain.on('pet:layout-applied', () => releaseHeldBox());

  ipcMain.on('pet:ball-fix', (_event, dx) => {
    lastBallFix = Number(dx) || 0;
    // Logged rather than sampled: the correction lives for a frame or two, so it is
    // almost impossible to catch by polling /state.
    if (process.env.PET_DEBUG && lastBallFix !== 0) log('ball-fix', lastBallFix);
  });

  ipcMain.on('pet:drag', (_event, active, moved) => {
    const next = Boolean(active);
    if (next) {
      if (!dragging) {
        dragging = true;
        applyPointerMode(true);
        startDragFollow();
      }
      // `moved` flips on the instant the press is recognised as a drag rather
      // than a click. Clear the whole interface right there — island *and* settings
      // panel — so a drag shows nothing but the ball in its resting state. Leaving
      // the panel open meant dragging with the settings panel up was a different,
      // messier gesture than dragging without it.
      if (moved && !dragRetracted) {
        dragRetracted = true;
        islandOpen = false;
        panelOpen = false;
        outsideSince = 0;
        hoverSuppressed = true;
        applyLayout();
        pushHover();
      }
      return;
    }
    if (!dragging) return;
    // One last followed step, then let the loop settle the ball onto the pointer
    // over the next few frames rather than snapping it there.
    stepDragFollow();
    dragging = false;
    stopDragFollow(true);
    // The latches are released now, so re-lay everything out unconditionally rather
    // than only when one of them flipped.
    applyLayout();
    push();
    // The island was cleared away so the ball could travel without it; bring it
    // back now the ball is down, so letting go over the ball expands it again.
    // The settings panel stays closed — it was dismissed by the drag, and popping
    // it back open under the pointer would just be in the way.
    hoverSuppressed = false;
    if (!islandOpen) {
      islandOpen = true;
      outsideSince = 0;
      pushHover();
    }
  });

  /**
   * Preference changes arrive once per slider input event — up to a hundred per
   * second while dragging. Everything here is therefore kept in memory: the
   * synchronous preferences write is debounced, and the window is left to the
   * animation loop plus the renderer's own CSS updates. Writing the file and
   * pushing a full snapshot per event is what made dragging stutter.
   */
  ipcMain.on('pet:set', (_event, patch) => {
    if (!patch || typeof patch !== 'object') return;
    const clean = {};
    if (Number.isFinite(patch.ballSize)) {
      clean.ballSize = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(patch.ballSize)));
    }
    if (Number.isFinite(patch.opacity)) clean.opacity = Math.min(1, Math.max(0.35, patch.opacity));
    if (!PLUGIN_MANAGED && typeof patch.autoStart === 'boolean') clean.autoStart = patch.autoStart;
    if (typeof patch.islandPinned === 'boolean') clean.islandPinned = patch.islandPinned;
    if (typeof patch.showBalance === 'boolean') clean.showBalance = patch.showBalance;
    if (typeof patch.showUptime === 'boolean') clean.showUptime = patch.showUptime;
    if (typeof patch.gameMode === 'boolean') clean.gameMode = patch.gameMode;
    if (Number.isFinite(patch.centerX) && Number.isFinite(patch.centerY)) {
      const centre = clampToDisplay(patch.centerX, patch.centerY);
      clean.centerX = centre.centerX;
      clean.centerY = centre.centerY;
    }
    if (Object.keys(clean).length === 0) return;

    Object.assign(store.data, clean);
    saveSoon();

    if (clean.autoStart !== undefined) applyAutoStart(clean.autoStart);
    if (clean.ballSize !== undefined) {
      // A bigger ball needs more room, so re-resolve the display it lives on,
      // then let the size chase its new target frame by frame.
      display = screen.getDisplayNearestPoint({
        x: Math.round(store.data.centerX),
        y: Math.round(store.data.centerY),
      });
      startSizeAnimation();
    } else if (clean.centerX !== undefined) {
      applyLayout();
    }
  });

  ipcMain.on('pet:metrics', (_event, next) => {
    if (!next || typeof next !== 'object') return;
    const width = Math.round(Number(next.width) || 0);
    const height = Math.round(Number(next.height) || 0);
    const islandW = Math.round(Number(next.islandW) || 0);
    const islandBaseSize = Number(next.size) || 0;
    if (!width || !height) return;
    const unchanged = Math.abs(width - metrics.width) < 1
      && Math.abs(height - metrics.height) < 1
      && Math.abs(islandW - (metrics.islandW || 0)) < 1;
    if (unchanged) return;
    metrics = { ...metrics, width, height, islandW, islandBaseSize };
    applyLayout();
  });

  ipcMain.on('pet:move-to', (_event, point) => {
    if (!point) return;
    const centre = clampToDisplay(Number(point.centerX) || 0, Number(point.centerY) || 0);
    store.data.centerX = centre.centerX;
    store.data.centerY = centre.centerY;
    dragDirty = true;

    // Re-resolving the display is a monitor enumeration; once every 300ms is
    // plenty while dragging across a multi-monitor desktop.
    const now = Date.now();
    if (now - lastDisplayCheck > 300) {
      lastDisplayCheck = now;
      display = screen.getDisplayNearestPoint({
        x: Math.round(centre.centerX),
        y: Math.round(centre.centerY),
      });
    }

    // A drag only changes position, so move the window instead of resizing it:
    // setPosition is a plain SetWindowPos, setBounds would also walk the whole
    // resize path for a transparent window on every animation frame.
    if (!win || win.isDestroyed()) return;
    const layout = computeLayout();
    const bounds = win.getBounds();
    const x = Math.round(layout.x);
    const y = Math.round(layout.y);
    if (bounds.x === x && bounds.y === y) return;
    win.setPosition(x, y, false);
  });

  ipcMain.on('pet:quit', () => app.quit());
}

/* --------------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock()) {
  log('another instance holds the lock — exiting');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.showInactive(); assertOnTop(); }
  });

  app.whenReady().then(() => {
    log('app ready');
    dsh.setWorkDir(app.getPath('userData'));
    // The helper is ours, not the machine's: recording this instance's pid in the
    // handshake is what stops a later pet from adopting a leftover helper that was
    // started by something else (and would therefore focus with the wrong token).
    dsh.setOwnerPid(process.pid);

    // Start the focus helper up front rather than on the first click. Two reasons:
    // the helper is what raises the DSH window on the machines where this process is
    // sandbox-restricted, and starting it here means it is already listening by the
    // time the ball is clicked — a click never has to wait for a process to boot.
    // Fire-and-forget: without it the click still tries, it just tries later.
    dsh.startFocusAgent()
      .then((handshake) => log('focus agent', handshake ? `up on port ${handshake.port}` : 'unavailable'))
      .catch((error) => log('focus agent failed', error.message));

    display = screen.getPrimaryDisplay();
    const fallback = defaultCentre();
    store.data.centerX = store.data.centerX ?? fallback.centerX;
    store.data.centerY = store.data.centerY ?? fallback.centerY;

    registerIpc();
    createWindow();
    createTray();
    log('tray created');
    if (process.env.PET_DEBUG) startDebugServer();

    applyAutoStart(store.data.autoStart);

    // A normal Cordis dispose asks the child to exit.  This watchdog covers the
    // less graceful cases (DSH is killed, crashes, or its host process is ended)
    // so the plugin can never leave an orphaned desktop window behind.
    if (PLUGIN_MANAGED && Number.isSafeInteger(PLUGIN_HOST_PID) && PLUGIN_HOST_PID > 0) {
      pluginHostTimer = setInterval(() => {
        try {
          process.kill(PLUGIN_HOST_PID, 0);
        } catch {
          log('DSH plugin host is gone — quitting');
          app.quit();
        }
      }, 2000);
      pluginHostTimer.unref?.();
    }

    refreshProcess();
    refreshBalance();
    // Self-scheduling rather than a fixed interval, so the cadence can follow the
    // state: every 2 s until DSH is seen, then the slow 15 s poll.
    const scheduleProcessProbe = () => {
      const delay = lastProbe.running ? PROCESS_INTERVAL_MS : PROCESS_FAST_INTERVAL_MS;
      processTimer = setTimeout(async () => {
        await refreshProcess();
        scheduleProcessProbe();
      }, delay);
      processTimer.unref?.();
    };
    scheduleProcessProbe();
    balanceTimer = setInterval(refreshBalance, BALANCE_INTERVAL_MS);
    cursorTimer = setInterval(pollCursor, CURSOR_POLL_MS);

    // Everything the pet does is decided from a cursor poll and a window box, and
    // both are things Windows can quietly invalidate without telling us: turning the
    // display off and on again, locking the session, docking, changing resolution.
    // The visible symptom is a ball you can see but cannot click, drag or open the
    // settings of — the window is still there and still drawn, it just stopped being
    // hit-tested the way it was.
    //
    // So every one of those events gets a full re-assert rather than a guess about
    // which part went stale.
    powerMonitor.on('resume', () => recoverAfterWake('resume'));
    powerMonitor.on('unlock-screen', () => recoverAfterWake('unlock-screen'));
    powerMonitor.on('suspend', () => log('power', 'suspend'));
    screen.on('display-added', () => recoverAfterWake('display-added'));
    screen.on('display-removed', () => recoverAfterWake('display-removed'));
    // The listener registered at the top of the file only re-lays out; this one
    // also re-asserts input, so the ball cannot come back unclickable.
    screen.on('display-metrics-changed', () => recoverAfterWake('display-metrics-changed'));

    // Persist a finished drag once the mouse settles. Never while a drag is in
    // flight: store.save() writes the file synchronously, and a disk write in
    // the middle of a drag is a visible hitch.
    setInterval(() => {
      if (dragDirty && !dragging) { dragDirty = false; saveSoon(0); }
    }, 800);
  }).catch((error) => log('whenReady failed', error.stack || error.message));

  app.on('window-all-closed', () => {
    log('all windows closed — quitting');
    app.quit();
  });
  app.on('before-quit', () => {
    clearInterval(balanceTimer);
    clearInterval(processTimer);
    clearInterval(cursorTimer);
    clearInterval(sizeTimer);
    clearInterval(pluginHostTimer);
    clearInterval(keepOnTopTimer);
    clearInterval(topmostGuardTimer);
    saveNow();
    dsh.stopFocusAgent();
  });
}

// Keep a single instance honest: no extra windows are ever created.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});
