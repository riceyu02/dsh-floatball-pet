'use strict';
/**
 * Renderer for the DSH floating ball.
 *
 * Division of labour: the main process polls the real cursor and decides hover
 * and click-through, and it also animates the ball diameter one frame at a time
 * so the window bounds can never disagree with what is drawn. This file only
 * paints what it is told, measures the island's content, and handles drag and
 * click gestures.
 */
const api = window.pet;

const stage = document.getElementById('stage');
const petEl = document.getElementById('pet');
const capsule = document.getElementById('capsule');
const orb = document.getElementById('orb');
const panel = document.getElementById('panel');
const gear = document.getElementById('gear');
const closeBtn = document.getElementById('close');
const sizeInput = document.getElementById('size');
const sizeOut = document.getElementById('sizeOut');
const opacityInput = document.getElementById('opacity');
const opacityOut = document.getElementById('opacityOut');
const autoStartInput = document.getElementById('autoStart');
const autoStartRow = document.getElementById('autoStartRow');
const dshManagedHint = document.getElementById('dshManagedHint');
const pinIslandInput = document.getElementById('pinIsland');
const ballImageName = document.getElementById('ballImageName');
const pickBallImageBtn = document.getElementById('pickBallImage');
const clearBallImageBtn = document.getElementById('clearBallImage');
const openDshBtn = document.getElementById('openDsh');
const quitBtn = document.getElementById('quit');
const balanceEl = document.getElementById('balance');
const uptimeEl = document.getElementById('uptime');
const lineBalance = document.getElementById('lineBalance');
const lineUptime = document.getElementById('lineUptime');
const islandInner = document.getElementById('islandInner');
const avatar = document.getElementById('avatar');

/** Throttled diagnostics, only when the window was opened with ?debug=1. */
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
let lastDebugAt = 0;
function debug(...parts) {
  if (!DEBUG) return;
  const now = Date.now();
  const force = parts[0] === '!';
  if (force) parts.shift();
  else if (now - lastDebugAt < 700) return;
  lastDebugAt = now;
  console.log(parts.join(' '));
}

let islandOpen = false;
let panelOpen = false;
let dragging = null;
let dshStartedAt = null;
let balanceSignature = '';
let sliderBusy = false;
let lastReportedIslandW = -1;
/** Diameter currently on screen; mirrors the main process' animated value. */
let renderedSize = 56;

/* ------------------------------------------------------------ hover / panel */

function setOpen(next) {
  if (next === islandOpen) return;
  islandOpen = next;
  debug('!', 'island open ->', next);
  capsule.classList.toggle('open', next);
  // A fresh open starts the width budget over from the current content.
  islandWidthLive = 0;
  syncIslandWidth();
}

function setPanelOpen(next) {
  if (next === panelOpen) return;
  panelOpen = next;
  panel.classList.toggle('show', next);
  panel.setAttribute('aria-hidden', next ? 'false' : 'true');
  gear.classList.toggle('on', next);
  if (next) reportMetrics();
}

function applyHover(state) {
  if (!state) return;
  setOpen(!!state.islandOpen);
  setPanelOpen(!!state.panelOpen);
}

/* --------------------------------------------------------------- geometry */

/**
 * Publish the island's natural width as `--island-w` and report it to the main
 * process, which needs it both for the window width and for the hover region.
 * The element is laid out with `width: max-content` even while collapsed, so its
 * box is measurable at all times.
 *
 * While the island is open the width is only ever allowed to grow: the uptime
 * line changes length every second (9秒 -> 10秒), and letting the capsule chase
 * that would make the whole thing twitch.
 *
 * `report` is false during the size animation: that runs 60 times a second, and
 * a round trip to the main process on every frame is exactly the kind of work
 * that makes dragging the slider stutter. The main process extrapolates the
 * island width meanwhile, and the exact value is handed over once it settles.
 */
let islandWidthLive = 0;
/** How much room the window reserves for the island on each side of the ball. */
let islandRoom = 326;
/** Widest the island may unfold. The panel is this plus one ball. */
let islandMax = 230;
function syncIslandWidth(report = true) {
  const measured = Math.ceil(islandInner.getBoundingClientRect().width);
  if (measured <= 0) return;
  // Never wider than the space reserved for it, or it would spill past the window.
  const capped = Math.min(measured, islandMax);
  islandWidthLive = islandOpen ? Math.max(islandWidthLive, capped) : capped;
  document.documentElement.style.setProperty('--island-w', `${islandWidthLive}px`);
  if (report && islandWidthLive !== lastReportedIslandW) {
    lastReportedIslandW = islandWidthLive;
    reportMetrics();
  }
}

/** The ball size the window is built for — where the island is at its widest. */
let frameSize = 0;
/** Widest the island has ever measured at the frame size: the panel matches it. */
let panelWidth = 0;

/**
 * Measure the island with the ball set to the frame (largest) size.
 *
 * The window is built for that size, so that is the widest the island can ever
 * get, and therefore how wide the settings panel has to be for the two to line
 * up. `--s` is swapped and restored inside one synchronous block: the forced
 * reflow is the whole point, and because nothing yields in between the
 * intermediate state is never painted.
 */
function measureIslandAtFrame() {
  if (!frameSize) return 0;
  const root = document.documentElement;
  const previous = root.style.getPropertyValue('--s');
  root.style.setProperty('--s', `${frameSize}px`);
  const w = Math.ceil(islandInner.getBoundingClientRect().width);
  root.style.setProperty('--s', previous || `${renderedSize}px`);
  // The island is text plus a gear, all ball-proportional, so at the frame size it
  // lands between roughly 1.2x and 3.2x the ball. Anything outside that is a
  // mid-layout artefact rather than a real width, and taking it seriously would
  // rebuild the window around a bogus number.
  if (w < frameSize * 1.2 || w > frameSize * 3.2) return 0;
  return w;
}

/**
 * Keep the settings panel as wide as the whole island gets at the largest ball —
 * ball included, since the island is the ball plus what unfolds out of it. So the
 * panel spans exactly what the capsule spans when the ball is at its biggest.
 *
 * Grow-only and capped at the room the window reserved: the island's length
 * depends on the text inside it (the uptime line lengthens as it counts up), and
 * letting the panel shrink again would make it twitch every second, while letting
 * it grow without limit would force the window to resize.
 */
function syncPanelWidth() {
  const island = measureIslandAtFrame();
  if (island <= 0) return;
  const wanted = Math.min(frameSize + Math.min(island, islandMax), islandRoom);
  if (wanted <= panelWidth) return;
  panelWidth = wanted;
  document.documentElement.style.setProperty('--panel-w', `${panelWidth}px`);
}

/* ------------------------------------------------------------ 调试探针 */
/* 只在 PET_DEBUG 下跑：把渲染进程里真实的样子报给主进程，/state 里能直接看到。
   排查「岛明明开了却没画出来」这类问题时，猜 CSS 不如直接读 DOM。 */
if (DEBUG) {
  setInterval(() => {
    const cs = getComputedStyle(document.documentElement);
    const islandEl = document.getElementById('island');
    const petEl = document.getElementById('pet');
    const linesEl = document.querySelector('.lines');
    const rectW = (el) => (el ? Math.round(el.getBoundingClientRect().width) : -1);
    const rectH = (el) => (el ? Math.round(el.getBoundingClientRect().height) : -1);
    const cs2 = (el) => (el ? getComputedStyle(el) : null);
    api.probe({
      capsuleClass: capsule.className,
      islandW: cs.getPropertyValue('--island-w').trim(),
      islandMax,
      islandLive: islandWidthLive,
      islandOpen,
      capsRect: rectW(capsule),
      petRect: rectW(petEl),
      islandRect: rectW(islandEl),
      innerRect: rectW(islandInner),
      linesRect: rectW(linesEl),
      islandDisplay: islandEl ? getComputedStyle(islandEl).display : '?',
      balance: balanceEl.textContent,
    });
  }, 1200);
}

function reportMetrics() {  // offsetHeight, not getBoundingClientRect: the rect includes the panel's
  // closed-state transform (translate + scale(0.965)), so the measurement changed
  // by ~10px depending on whether the panel happened to be open. The main process
  // sizes the window from this number, so that difference used to resize the
  // window every time the panel opened or closed — and resizing a transparent
  // window flashes. The offset box is layout-only and therefore stable.
  const h = panel.offsetHeight;
  if (h <= 0 || panelWidth <= 0) return;
  api.setMetrics({
    // The width the panel has been set to, not the width it currently measures:
    // it is the island's widest that the main process needs to lay out around.
    width: panelWidth,
    height: Math.ceil(h),
    islandW: Math.ceil(islandInner.getBoundingClientRect().width),
    // Which ball size this measurement belongs to, so the main process can scale
    // it while the ball is mid-animation.
    size: renderedSize,
  });
}

/** One frame of the main process' ball-size animation. */
function applySize(state) {
  if (!state) return;
  const resized = state.size !== renderedSize;
  renderedSize = state.size;
  document.documentElement.style.setProperty('--s', `${state.size}px`);
  stage.classList.toggle('resizing', !!state.resizing);
  // The island is grow-only while it is open so that the uptime line ticking from
  // 9秒 to 10秒 cannot make it twitch. That latch must not survive a change of the
  // ball's diameter though, or the island keeps whatever length it had when the
  // ball was at its largest and never shrinks back with it.
  if (resized) islandWidthLive = 0;
  // Unfolding to the left, the ball's place inside the window is measured from the
  // right and therefore changes with the diameter, so every size frame is another
  // chance for the window and the drawing to disagree by one frame. Main sends the
  // target position along with each frame; check it after the frame is painted.
  if (typeof state.ballX === 'number' && state.orbLeft !== packedOrbLeft) {
    // Unfolding to the left, the ball's place inside the window is measured from the
    // right, so every size frame is a packing change and gets the same treatment.
    const dx = state.ballX - (window.screenX + state.orbLeft);
    packedOrbLeft = state.orbLeft;
    if (Math.abs(dx) >= 0.5) holdBallFix(dx);
    api.layoutApplied();
  }
  syncIslandWidth(!state.resizing);
  if (!state.resizing) {
    // Settled: re-measure once more now that the fonts have re-laid out.
    requestAnimationFrame(() => syncIslandWidth(true));
  }
}

/* ------------------------------------------------------------ 悬浮球图标 */

const DEFAULT_BALL_IMAGE = avatar.getAttribute('src');
let ballImageShown = null;

/**
 * Point the ball at the user's picture, or back at the built-in art.
 *
 * The main process hands over a `file://` URL (built with pathToFileURL, so spaces
 * and CJK in the path are encoded properly) and does the "is this actually an image"
 * check by magic number. An animated GIF needs nothing special here — an `<img>`
 * plays one by itself.
 *
 * Compared against what is already shown so a re-render does not restart a GIF from
 * frame zero every time a snapshot arrives.
 */
function applyBallImage(url) {
  const next = url || null;
  if (next === ballImageShown) return;
  ballImageShown = next;
  avatar.classList.toggle('custom', Boolean(next));
  avatar.src = next || DEFAULT_BALL_IMAGE;
  ballImageName.textContent = next ? decodeURIComponent(next.split('/').pop()) : '默认立绘';
  clearBallImageBtn.disabled = !next;
}

pickBallImageBtn.addEventListener('click', async () => {
  const result = await api.pickBallImage();
  if (!result || result.ok) return;             // ok → the next snapshot carries the URL
  if (result.canceled) return;                  // the user changed their mind
  // Report a refusal in the field itself; the next snapshot restores the real name.
  ballImageName.textContent = result.detail || '这个文件用不了';
});

clearBallImageBtn.addEventListener('click', () => {
  api.clearBallImage();
});

/* --------------------------------------------------------------------- data */

function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}天 ${h}时 ${m}分 ${sec}秒`;
  if (h > 0) return `${h}时 ${m}分 ${sec}秒`;
  if (m > 0) return `${m}分 ${sec}秒`;
  return `${sec}秒`;
}

function formatUptimeLong(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d} 天 ${h} 小时 ${m} 分 ${s % 60} 秒`;
}

function renderBalance(balance) {
  const hasValue = balance && typeof balance.amount === 'number' && Number.isFinite(balance.amount);
  const symbol = balance && balance.currency === 'USD' ? '$' : '¥';
  const text = hasValue ? `${symbol}${balance.amount.toFixed(2)}` : '--';
  const signature = `${text}|${balance ? balance.source : ''}`;
  if (signature !== balanceSignature) {
    balanceSignature = signature;
    balanceEl.textContent = text;
    balanceEl.classList.remove('flash');
    void balanceEl.offsetWidth;
    balanceEl.classList.add('flash');
  }
  const sourceLabel = {
    account: 'DSH 账号登录态',
    'api-key': 'DEEPSEEK_API_KEY',
    cached: '上次观测值（离线）',
    pending: '读取中…',
    none: '未配置',
    error: '读取失败',
  }[balance ? balance.source : 'pending'] || '';
  const parts = [`余额来源：${sourceLabel}`];
  if (balance && balance.bonus) parts.push(`含赠金 ${symbol}${balance.bonus.toFixed(2)}`);
  if (balance && balance.error) parts.push(`备注：${balance.error}`);
  balanceEl.title = parts.join('\n');
}

/** Transient message shown in the uptime line, e.g. when DSH cannot be raised. */
let hintText = '';
let hintUntil = 0;
function showHint(text, ms = 3200) {
  hintText = text;
  hintUntil = Date.now() + ms;
  renderUptime();
}

function renderUptime() {
  if (hintText && Date.now() < hintUntil) {
    uptimeEl.textContent = hintText;
    uptimeEl.title = hintText;
    syncIslandWidth();
    syncPanelWidth();
    return;
  }
  hintText = '';
  if (dshStartedAt == null) {
    uptimeEl.textContent = '未运行';
    uptimeEl.title = 'DeepSeek Harness 当前没有在运行';
  } else {
    const seconds = (Date.now() - dshStartedAt) / 1000;
    uptimeEl.textContent = formatUptime(seconds);
    uptimeEl.title = `DeepSeek Harness 已运行 ${formatUptimeLong(seconds)}`;
  }
  syncIslandWidth();
  // Once a second, on the same beat as the uptime text: that text is what makes
  // the island grow 9秒 → 10秒 → 1分 0秒, so it is the only thing that can widen
  // the panel.
  syncPanelWidth();
}

/* ------------------------------------------- keeping the ball where main says */

/**
 * Where the ball's outer edge sits inside the window, and the packing that goes with
 * it.
 *
 * Main owns the window's position; the ball's place inside it arrives over IPC. Two
 * routes, one frame boundary — so for the frame between them they can disagree. The
 * island swapping sides is exactly such a moment: the ball's place inside the window
 * jumps by `frame - size` while the window jumps the other way to hold the ball on
 * screen. Moving the window first therefore paints the ball that far off, which is
 * the sideways flash seen when a drag crosses the screen's midline — and it is worse
 * for a smaller ball precisely because `frame - size` grows as the ball shrinks.
 *
 * Two things fix it:
 *
 *   1. Main does not move the window until we say the new packing is on screen
 *      (see `commitWindowBox`), so the order is never "window first".
 *   2. For as long as the window has not actually moved, we draw the ball where it
 *      belongs anyway, by shifting it by the difference. `window.screenX` is the
 *      browser's own idea of the window position, so the moment the move lands the
 *      shift is dropped.
 *
 * The shift is deliberately a one-shot hold rather than a value recomputed every
 * frame: the ball is being dragged while all this happens, so a target captured at
 * the swap would go stale within a frame or two and the "correction" would start
 * dragging the ball backwards.
 */
let packedOrbLeft = null;
let ballFixX = 0;
let ballFixRaf = 0;

function holdBallFix(dx) {
  ballFixX = dx;
  petEl.style.transform = `translateX(${dx}px)`;
  api.reportBallFix(Math.round(dx * 10) / 10);
  const from = window.screenX;
  let frames = 0;
  const watch = () => {
    ballFixRaf = 0;
    frames += 1;
    // Released when the window really moves — or after a few frames, so a move that
    // never comes cannot leave the ball permanently offset.
    if (window.screenX !== from || frames > 8) {
      ballFixX = 0;
      petEl.style.transform = '';
      api.reportBallFix(0);
      return;
    }
    ballFixRaf = requestAnimationFrame(watch);
  };
  if (!ballFixRaf) ballFixRaf = requestAnimationFrame(watch);
}

/**
 * Apply the parts of a layout that decide where the ball is drawn. Split out so the
 * main process can hand over a new packing on its own, ahead of the snapshot that
 * carries the rest.
 */
function applyPacking(layout) {
  document.documentElement.style.setProperty('--s', `${layout.size}px`);
  if (layout.edge !== undefined) {
    // The ball's pinned outer edge, and the edge the panel lines up with.
    document.documentElement.style.setProperty('--ball-edge', `${layout.edge}px`);
    document.documentElement.style.setProperty('--ball-y', `${layout.ballY}px`);
    document.documentElement.style.setProperty('--room', `${layout.room}px`);
    islandRoom = layout.room;
    if (layout.islandMax) islandMax = layout.islandMax;
  }
  if (layout.frame) frameSize = layout.frame;
  stage.classList.toggle('side-left', layout.side === 'left');
  stage.classList.toggle('panel-below', !!layout.panelBelow);
  panel.classList.toggle('below', !!layout.panelBelow);

  // A correction only means anything at the instant the ball's place inside the
  // window changes. During an ordinary drag the window moves every tick and this
  // number stays put, so there is nothing to correct and nothing to hold.
  const packingChanged = typeof layout.ballX === 'number' && layout.orbLeft !== packedOrbLeft;
  if (packingChanged) {
    packedOrbLeft = layout.orbLeft;
    // The window is still where it was, so this is how far the ball would be drawn
    // from where it belongs. Main is holding the window until we answer.
    const dx = layout.ballX - (window.screenX + layout.orbLeft);
    if (Math.abs(dx) >= 0.5) holdBallFix(dx);
    api.layoutApplied();
  }
}

/* ------------------------------------------------------------------ snapshot */

function apply(snapshot) {
  const { config, layout, data } = snapshot;

  applyPacking(layout);
  // The panel is as wide as the island gets at the largest ball size — measure it
  // before anything is drawn with the old width.
  syncPanelWidth();
  document.documentElement.style.setProperty('--op', String(config.opacity));

  if (!sliderBusy) {
    sizeInput.value = String(config.ballSize);
    sizeOut.textContent = `${config.ballSize} px`;
    opacityInput.value = String(Math.round(config.opacity * 100));
    opacityOut.textContent = `${Math.round(config.opacity * 100)}%`;
  }
  autoStartInput.checked = !!config.autoStart;
  autoStartRow.hidden = !!config.managedByDsh;
  dshManagedHint.hidden = !config.managedByDsh;
  quitBtn.textContent = config.managedByDsh ? '本次关闭' : '退出';
  quitBtn.title = config.managedByDsh ? '关闭到下次启动 DSH' : '';
  pinIslandInput.checked = !!config.islandPinned;


  applyBallImage(config.ballImage);

  lineBalance.style.display = config.showBalance ? '' : 'none';
  lineUptime.style.display = config.showUptime ? '' : 'none';

  renderBalance(data.balance);
  dshStartedAt = data.dsh && data.dsh.startedAt != null ? data.dsh.startedAt : null;
  renderUptime();
  if (snapshot.hover) applyHover(snapshot.hover);
  syncIslandWidth();
  reportMetrics();
}

/* ------------------------------------------------------------------ pointer */

// Only drag gestures and clicks live here; hover belongs to the main process.
capsule.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  if (event.target.closest('#gear')) return;
  const rect = orb.getBoundingClientRect();
  dragging = {
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    ballX: window.screenX + rect.left + rect.width / 2,
    ballY: window.screenY + rect.top + rect.height / 2,
    moved: false,
  };
  capsule.classList.add('dragging');
  // Press started, but not yet a drag: the main process begins following the
  // pointer immediately, and only retracts the island once `moved` turns true.
  api.setDragging(true, false);
  event.preventDefault();
});

/**
 * Drag handling.
 *
 * The renderer only decides whether a press is a click or a drag; the actual
 * moving is done by the main process, which follows the real cursor every frame.
 * Driving it from here does not work: renderer `mousemove` arrives far faster
 * than a large transparent window can be repositioned, so the window fell behind
 * the pointer, the ball drifted away from the cursor, and the pointer flickered
 * between grab and arrow as it slipped off the ball.
 */
window.addEventListener('mousemove', (event) => {
  if (!dragging || dragging.moved) return;
  const dx = event.screenX - dragging.startScreenX;
  const dy = event.screenY - dragging.startScreenY;
  if (Math.hypot(dx, dy) > 4) {
    dragging.moved = true;
    document.documentElement.classList.add('dragging-now');
    // Only now is this a drag rather than a click: the main process retracts the
    // island at this point and keeps it away until the pointer leaves the pet.
    api.setDragging(true, true);
  }
});

window.addEventListener('mouseup', (event) => {
  if (!dragging) return;
  const finished = dragging;
  dragging = null;
  capsule.classList.remove('dragging');
  document.documentElement.classList.remove('dragging-now');
  api.setDragging(false, finished.moved);
  if (finished.moved) return; // the main process persists the dropped position
  if (event.target.closest && event.target.closest('#gear')) return;
  fireOpenDsh();
});

async function fireOpenDsh() {
  capsule.classList.add('firing');
  setTimeout(() => capsule.classList.remove('firing'), 640);
  try {
    const result = await api.openDsh();
    if (result && result.action !== 'focused' && result.action !== 'launched') {
      showHint(result.action === 'focus-failed' ? 'DSH 未响应前置' : '未找到 DSH');
      console.warn('[pet] open-dsh:', result.action, result.detail || '');
    }
  } catch (error) {
    console.error('[pet] open-dsh failed:', error);
  }
}

/* ------------------------------------------------------------------ controls */

gear.addEventListener('click', (event) => {
  event.stopPropagation();
  api.setPanel(!panelOpen);
});

closeBtn.addEventListener('click', () => api.setPanel(false));
openDshBtn.addEventListener('click', () => fireOpenDsh());
quitBtn.addEventListener('click', () => api.quit());

sizeInput.addEventListener('pointerdown', () => { sliderBusy = true; });
opacityInput.addEventListener('pointerdown', () => { sliderBusy = true; });
window.addEventListener('pointerup', () => { sliderBusy = false; });

sizeInput.addEventListener('input', () => {
  const value = Number(sizeInput.value);
  sizeOut.textContent = `${value} px`;
  // The main process animates the actual diameter; the slider only states the target.
  api.set({ ballSize: value });
});

opacityInput.addEventListener('input', () => {
  const percent = Number(opacityInput.value);
  opacityOut.textContent = `${percent}%`;
  document.documentElement.style.setProperty('--op', String(percent / 100));
  api.set({ opacity: percent / 100 });
});

autoStartInput.addEventListener('change', () => {
  api.set({ autoStart: autoStartInput.checked });
});

// "灵动岛常驻展开": the main process owns the open/closed state (hover is decided
// there from the real cursor), so switching this on takes effect on the next poll —
// and switching it off lets the island fold away as soon as the pointer is away.
pinIslandInput.addEventListener('change', () => {
  api.set({ islandPinned: pinIslandInput.checked });
});


document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.setPanel(false);
});

window.addEventListener('contextmenu', (event) => event.preventDefault());

/* -------------------------------------------------------------------- boot */

// A missing avatar must never leave an empty ball behind.
avatar.addEventListener('error', () => {
  console.error('[pet] ball art failed to load:', avatar.getAttribute('src'));
  avatar.style.display = 'none';
  orb.style.background = 'radial-gradient(120% 120% at 34% 26%, #6f8dff, #0a0b10 70%)';
});

api.onSnapshot(apply);
api.onHover(applyHover);
api.onSize(applySize);
  api.onLayout(applyPacking);
api.ready().then((snapshot) => {
  apply(snapshot);
  applyHover(snapshot.hover);
  debug('!', 'pet.js ready debug=' + DEBUG, 'ball=' + snapshot.config.ballSize,
        'side=' + snapshot.layout.side);
});

setInterval(renderUptime, 1000);

window.addEventListener('load', () => {
  syncIslandWidth();
  syncPanelWidth();
  reportMetrics();
  setTimeout(() => { syncPanelWidth(); reportMetrics(); }, 220);
  setTimeout(() => { syncPanelWidth(); reportMetrics(); }, 900);
});

if (document.fonts && document.fonts.ready) {
  // The island's length is text, so it is only measurable once the real font has
  // loaded — re-measure both here.
  document.fonts.ready
    .then(() => { syncIslandWidth(); syncPanelWidth(); reportMetrics(); })
    .catch(() => {});
}
