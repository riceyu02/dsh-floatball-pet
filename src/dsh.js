'use strict';
/**
 * Everything this app knows about DeepSeek Harness: where it lives, whether it
 * runs, how long it has been up, how to raise its window, and how to read the
 * DeepSeek account balance through the credential DSH already stored.
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CREDENTIALS = path.join(DSH_HOME, '.credentials.yaml');
const WHALE_USAGE = path.join(DSH_HOME, '.dshw-usage.json');
const PET_VERSION = require('../package.json').version;

/**
 * Where DeepSeek Harness might be, in the order worth trying.
 *
 * Only consulted to LAUNCH DSH when it is not already running: while DSH is up its
 * real path is read back from the live process (see probeProcesses), which is why
 * that case already worked on any machine. So this list only has to cover the
 * cold-start case on machines this was not written on — hence the standard installer
 * locations rather than the author's drive letter.
 *
 * Both spellings of the folder are tried because the installer and the docs disagree
 * about the space (`DeepSeek Harness` vs `DeepSeekHarness`), and `DSH_DESKTOP_EXE`
 * still wins outright when someone keeps DSH somewhere else entirely.
 *
 * A list of standard locations cannot be enough on its own, though: an install that
 * went anywhere else — `D:\DeepSeekHarness` on the machine this was written on — is
 * only findable through the record the installer leaves behind, which is what
 * `installedDshExes` reads.
 */
const DSH_FOLDER_NAMES = ['DeepSeek Harness', 'DeepSeekHarness'];
const EXE_CANDIDATES = [
  process.env.DSH_DESKTOP_EXE,
  // per-user install: what the installer does by default
  ...DSH_FOLDER_NAMES.map((n) => path.join(process.env.LOCALAPPDATA || '', 'Programs', n, 'DeepSeek Harness.exe')),
  // machine-wide install
  ...DSH_FOLDER_NAMES.map((n) => path.join(process.env.ProgramFiles || 'C:\\Program Files', n, 'DeepSeek Harness.exe')),
  // 32-bit install on 64-bit Windows
  ...DSH_FOLDER_NAMES.map((n) => path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', n, 'DeepSeek Harness.exe')),
  // a portable copy unpacked next to the user profile
  ...DSH_FOLDER_NAMES.map((n) => path.join(os.homedir(), n, 'DeepSeek Harness.exe')),
].filter(Boolean);

/**
 * Where the installer actually put DSH, read back from its uninstall record.
 *
 * This is the case the fixed list above cannot cover: an install that is not in any
 * standard location. It is still machine-independent — the record is keyed by the
 * product name, not by one machine's drive letter — which is the whole point, since
 * hard-coding this machine's `D:\DeepSeekHarness` is what we are avoiding.
 *
 * Cached, because it spawns `reg.exe` and is only ever consulted for a cold start.
 * Every failure mode (`reg.exe` absent, no record, a record with no usable path) is
 * just an empty list, leaving the static candidates to have their say.
 */
let installedDshCache = null;
function installedDshExes() {
  if (installedDshCache) return installedDshCache;
  installedDshCache = [];
  if (process.platform !== 'win32') return installedDshCache;

  for (const [root, view] of [['HKCU', null], ['HKLM', null], ['HKLM', '/reg:32']]) {
    const key = `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall`;
    const args = ['query', key, '/s', '/f', 'DeepSeek Harness', '/d'];
    if (view) args.push(view);

    let out;
    try {
      // `/d` searches value data, which is where the product name lives. A query that
      // matches nothing exits non-zero, which is an ordinary answer here, not a fault.
      out = execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    } catch {
      continue;
    }

    // Walk the output one key at a time. The search also matches products that merely
    // mention DSH — the DSH Desktop shell registers alongside it — so a path is only
    // trusted from a key whose own DisplayName is DSH itself.
    for (const block of out.split(/^(?=HKEY_)/m)) {
      if (!/^\s{4}DisplayName\s+REG_\w+\s+DeepSeek Harness(\s|$)/m.test(block)) continue;
      for (const line of block.split(/\r?\n/)) {
        const match = /^\s{4}(?:InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+?)\s*$/.exec(line);
        if (!match) continue;
        // DisplayIcon carries a resource index: `…\DeepSeek Harness.exe,0`
        const value = match[1].replace(/,\d+$/, '').trim();
        const exe = /\.exe$/i.test(value) ? value : path.join(value, 'DeepSeek Harness.exe');
        if (fs.existsSync(exe) && !installedDshCache.includes(exe)) installedDshCache.push(exe);
      }
    }
  }
  return installedDshCache;
}

let lastGoodBalance = null;

/* ------------------------------------------------------------------ yaml */

/**
 * Parse the small, flat subset of YAML the DSH credential store uses
 * (`key: value` and `key:` + indented children). Not a general YAML parser.
 */
function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const raw of String(text).split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const sep = trimmed.indexOf(':');
    if (sep < 0) continue;
    const key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (value === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      parent[key] = value;
    }
  }
  return root;
}

/** Read the stored DSH account grant (token + issuing origin) if the user signed in. */
function readAccountGrant() {
  try {
    const doc = parseSimpleYaml(fs.readFileSync(CREDENTIALS, 'utf8'));
    for (const [name, record] of Object.entries(doc.records || {})) {
      if (!name.startsWith('deepseek-account-platform/')) continue;
      const payload = record && record.payload;
      if (payload && typeof payload.token === 'string' && payload.token) {
        return { token: payload.token, issuer: payload.issuer || null };
      }
    }
  } catch {
    /* no credential store — fall through */
  }
  return null;
}

/** Read a DeepSeek *platform API key*, if the user configured one instead. */
function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const doc = parseSimpleYaml(fs.readFileSync(CREDENTIALS, 'utf8'));
    for (const [name, record] of Object.entries(doc.records || {})) {
      if (!/api[-_]?key/i.test(name)) continue;
      const payload = (record && record.payload) || {};
      const value = payload.value || payload.key || payload.secret;
      if (typeof value === 'string' && value) return value;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/* -------------------------------------------------------------- balance */

function normaliseOrigin(issuer) {
  if (typeof issuer !== 'string') return null;
  try {
    const url = new URL(issuer);
    return url.protocol === 'https:' || url.hostname === '127.0.0.1' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Client identity headers DSH's account provider sends; mirrored so the call is accepted. */
function platformHeaders(token) {
  return {
    accept: 'application/json',
    'x-dsh-auth-token': token,
    'x-client-bundle-id': '',
    'x-client-platform': process.platform === 'win32' ? 'desktop-win' : 'desktop-mac',
    'x-client-version': PET_VERSION,
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  };
}

/** Locate the wallet arrays wherever the envelope happens to nest them. */
function findWallets(payload) {
  const seen = new Set();
  const queue = [payload];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current.normal_wallets)) {
      return { normal: current.normal_wallets, bonus: current.bonus_wallets || [] };
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function toAmount(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function summarise(normal, bonus) {
  if (!Array.isArray(normal) || normal.length === 0) return null;
  const primary = normal.find((w) => w && w.currency === 'CNY') || normal[0];
  const currency = (primary && primary.currency) || 'CNY';
  const total = normal
    .filter((w) => w && w.currency === currency)
    .reduce((sum, w) => sum + (toAmount(w.balance) ?? 0), 0);
  const gift = bonus
    .filter((w) => w && w.currency === currency)
    .reduce((sum, w) => sum + (toAmount(w.balance) ?? 0), 0);
  return { amount: total, bonus: gift, currency };
}

async function fetchAccountBalance(grant) {
  const origin = normaliseOrigin(grant.issuer) || 'https://platform.deepseek.com';
  const response = await fetch(`${origin}/api/v0/users/get_user_summary`, {
    method: 'GET',
    redirect: 'error',
    headers: platformHeaders(grant.token),
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 401) throw new Error('账号登录态已失效（HTTP 401）');
  if (!response.ok) throw new Error(`账号接口 HTTP ${response.status}`);
  const wallets = findWallets(await response.json());
  if (!wallets) throw new Error('账号接口返回了无法识别的结构');
  const summary = summarise(wallets.normal, wallets.bonus);
  if (!summary) throw new Error('账号没有可用钱包');
  return { ...summary, source: 'account' };
}

async function fetchApiKeyBalance(key) {
  const response = await fetch('https://api.deepseek.com/user/balance', {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'application/json', authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 401) throw new Error('DEEPSEEK_API_KEY 无效（HTTP 401）');
  if (!response.ok) throw new Error(`余额接口 HTTP ${response.status}`);
  const payload = await response.json();
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
  const normal = infos.map((i) => ({ currency: i.currency, balance: i.total_balance }));
  const bonus = infos.map((i) => ({ currency: i.currency, balance: i.granted_balance }));
  const summary = summarise(normal, bonus);
  if (!summary) throw new Error('余额接口没有返回钱包');
  return { ...summary, source: 'api-key' };
}

/** Last balance the whale widget observed — offline fallback so the island is never blank. */
function readCachedBalance() {
  try {
    const doc = JSON.parse(fs.readFileSync(WHALE_USAGE, 'utf8'));
    const amount = toAmount(doc.lastBalance);
    if (amount === null) return null;
    return { amount, bonus: 0, currency: 'CNY', source: 'cached' };
  } catch {
    return null;
  }
}

/**
 * Resolve a balance using the best available source, degrading gracefully.
 * @returns {Promise<{amount:number,currency:string,source:string,error?:string}>}
 */
async function readBalance() {
  const failures = [];
  const grant = readAccountGrant();
  if (grant) {
    try {
      lastGoodBalance = await fetchAccountBalance(grant);
      return lastGoodBalance;
    } catch (error) {
      failures.push(error.message);
    }
  }
  const key = readApiKey();
  if (key) {
    try {
      lastGoodBalance = await fetchApiKeyBalance(key);
      return lastGoodBalance;
    } catch (error) {
      failures.push(error.message);
    }
  }
  const cached = lastGoodBalance || readCachedBalance();
  if (cached) return { ...cached, error: failures[0] };
  return {
    amount: null,
    currency: 'CNY',
    source: 'none',
    error: failures[0] || (grant ? '余额读取失败' : '未登录 DSH 账号，也没有 DEEPSEEK_API_KEY'),
  };
}

/* --------------------------------------------------------------- process */

/**
 * Run a PowerShell snippet and return its stdout.
 *
 * The script travels as a base64 UTF-16LE `-EncodedCommand`, which sidesteps
 * every cmd/PowerShell quoting hazard a multi-line script would otherwise hit.
 */
function runPowerShell(script, timeout = 12000) {
  // Windows PowerShell writes its console in the OEM code page; force UTF-8 so
  // non-ASCII diagnostics survive the trip back into Node.
  const source = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n${script}`;
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout, windowsHide: true, maxBuffer: 1 << 20, encoding: 'utf8' },
      (error, stdout) => resolve(error && !stdout ? '' : String(stdout || '')),
    );
  });
}

/**
 * Which PowerShell host is actually running our scripts, resolved once.
 *
 * The focus routine fails differently depending on the host — a normal Windows
 * PowerShell can compile the C# that raising a window needs, while a
 * ConstrainedLanguage / AppLocker-restricted one cannot — and the two are
 * indistinguishable from the failure text alone. This is only ever put in a
 * diagnostic string, so it is resolved lazily and cached.
 */
let psIdentity = null;
async function powerShellIdentity() {
  if (psIdentity === null) {
    try {
      const out = await runPowerShell('$PSVersionTable.PSVersion.ToString() + " lang=" + $ExecutionContext.SessionState.LanguageMode');
      psIdentity = out.trim() || 'unknown';
    } catch {
      psIdentity = 'unavailable';
    }
  }
  return psIdentity;
}

/**
 * The port DSH's web server is listening on.
 *
 * `DSH_WEB_URL` wins, and it is exact: whoever launched the pet is the process that is
 * listening (the DSH plugin hands it over — see `helperEnvironment` in plugin/host.mjs).
 * The other two are guesses. `$DSH_HOME/dsh-web-url.log` is only as fresh as the last
 * launcher that wrote it, and 19387 is the port DSH used to keep; both were accurate
 * until DSH began binding an ephemeral port. A guess that misses is not harmless — the
 * island then reports 「未运行」 while DSH is plainly on screen — so `probeDsh` follows
 * a miss with `lookupDshPort`, and the port that check finds is remembered here.
 */
function dshWebPort() {
  if (osPort !== null) return osPort;
  if (process.env.DSH_WEB_URL) {
    try {
      const port = Number(new URL(process.env.DSH_WEB_URL).port);
      if (port > 0) return port;
    } catch {
      /* not a URL — fall through to the guesses below */
    }
  }
  try {
    const log = fs.readFileSync(path.join(DSH_HOME, 'dsh-web-url.log'), 'utf8');
    const match = [...log.matchAll(/127\.0\.0\.1:(\d+)/g)].pop();
    if (match) return Number(match[1]);
  } catch {
    /* ignore */
  }
  return 19387;
}

/** Port Windows confirmed a DSH process is listening on; null until one is found. */
let osPort = null;
/** When `lookupDshPort` last asked Windows, so a broken guess cannot spawn a shell per poll. */
let lastPortLookupAt = 0;
const PORT_LOOKUP_COOLDOWN_MS = 30 * 1000;

/** Cheap liveness check: does anything accept connections on the DSH web port? */
function portListening(port, timeout = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, '127.0.0.1');
    } catch {
      finish(false);
    }
  });
}

/**
 * Ask Windows which port a DSH process holds open.
 *
 * Nothing else in the system knows the answer as reliably: whatever is serving the DSH
 * web UI is a `DeepSeek Harness` process, and Windows can name its listening sockets
 * even when no environment variable and no log file mentions the port. It costs a
 * PowerShell round trip, so a hit is kept for the life of the process and a miss is
 * retried no more often than `PORT_LOOKUP_COOLDOWN_MS` — the "not running" poll runs
 * every two seconds, and spawning a shell on each of those would be absurd.
 */
async function lookupDshPort() {
  if (osPort !== null) return osPort;
  if (process.platform !== 'win32') return null;
  const now = Date.now();
  if (now - lastPortLookupAt < PORT_LOOKUP_COOLDOWN_MS) return null;
  lastPortLookupAt = now;

  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$ids=@(Get-Process -Name 'DeepSeek Harness' | ForEach-Object { $_.Id })",
    'if ($ids.Count -eq 0) { exit }',
    '$p=Get-NetTCPConnection -State Listen | Where-Object { $ids -contains $_.OwningProcess } | Select-Object -First 1 -ExpandProperty LocalPort',
    'if ($p) { "$p" }',
  ].join('\n');

  let raw = '';
  try {
    raw = (await runPowerShell(script, 8000)).trim();
  } catch {
    return null;
  }
  const port = Number.parseInt(raw.split(/\r?\n/).pop() || '', 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  osPort = port;
  return port;
}

/**
 * Ask Windows for the DSH desktop processes (or whoever owns the DSH web port)
 * and their start times. Returns nulls when the probe cannot run.
 */
async function probeProcesses(port) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$items=@()',
    "Get-Process -Name 'DeepSeek Harness' | ForEach-Object {",
    '  $items += [pscustomobject]@{ id=$_.Id; start=$_.StartTime.ToUniversalTime().ToString("o");',
    '    title=$_.MainWindowTitle; path=$_.Path } }',
    'if ($items.Count -eq 0) {',
    `  $c = Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -First 1`,
    '  if ($c) { $p = Get-Process -Id $c.OwningProcess',
    '    if ($p) { $items += [pscustomobject]@{ id=$p.Id; start=$p.StartTime.ToUniversalTime().ToString("o");',
    '      title=$p.MainWindowTitle; path=$p.Path } } } }',
    'ConvertTo-Json -InputObject @($items) -Compress -Depth 4',
  ].join('\n');

  const raw = (await runPowerShell(script)).trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => item && item.id);
  if (list.length === 0) return null;

  let earliest = null;
  for (const item of list) {
    const started = Date.parse(item.start);
    if (!Number.isFinite(started)) continue;
    if (earliest === null || started < earliest) earliest = started;
  }
  return {
    count: list.length,
    startedAt: earliest,
    exePath: list.find((item) => item.path)?.path || null,
    hasWindow: list.some((item) => item.title),
  };
}

/**
 * The precompiled focus routine: `<this file's folder>/PetFocus.dll`.
 *
 * Inside the app folder on purpose. `__dirname` differs between a packaged app
 * (`app.asar/src`) and a hand-assembled one (`resources/app/src`), so a path that
 * climbs out to `resources/build` only resolves in one of them; a sibling does not
 * have that problem.
 *
 * With `asar: true` this file is additionally unpacked by electron-builder, and the
 * unpacked copy is preferred: the DLL is handed to *PowerShell*, a separate process
 * that cannot read through the asar archive. See focusDshViaDll for why the DLL
 * exists at all — compiling C# at runtime needs a temporary `csc.exe`, and creating
 * that child process is the one thing a restricted process tree refuses.
 */
const FOCUS_DLL_CANDIDATES = [
  path.join(__dirname, 'PetFocus.dll'),
  path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'PetFocus.dll'),
];
function focusDllPath() {
  for (const candidate of FOCUS_DLL_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Start instant we inferred ourselves when Windows could not tell us. */
let inferredStart = null;
/** When a probe last found nothing listening on the DSH web port. */
let lastClosedAt = null;

/**
 * Report whether DeepSeek Harness is up and for how long.
 *
 * Liveness comes from the DSH web port (no subprocess); the authoritative
 * process start time is fetched from Windows once per DSH run and remembered.
 * The port itself has to be found before it can be connected to, which is the
 * one thing `dshWebPort` cannot always do on its own — see the lookup below.
 */
async function probeDsh() {
  let port = dshWebPort();
  let alive = await portListening(port);

  if (!alive) {
    // The guessed port answered nothing. A remembered port that stopped answering is
    // worthless — DSH came up somewhere else — so forget it, then ask Windows which
    // port a DSH process actually holds. Without this the island reports 「未运行」 for
    // as long as the guess stays wrong, which is what an ephemeral port makes permanent.
    if (osPort !== null && port === osPort) osPort = null;
    const found = await lookupDshPort();
    if (found !== null && found !== port) {
      port = found;
      alive = await portListening(port);
    }
  }

  if (!alive) {
    inferredStart = null;
    lastClosedAt = Date.now();
    return { running: false, processes: 0, seconds: null, startedAt: null, exePath: null, port };
  }

  const info = await probeProcesses(port);
  if (info && info.startedAt !== null) {
    inferredStart = info.startedAt;
  } else if (inferredStart === null) {
    // Windows would not tell us: a restricted token cannot read another process's
    // StartTime — the very limitation the focus helper exists for. Counting from
    // "now" is what made the uptime begin when the ball *noticed* DSH rather than when
    // DSH started. Two better guesses, in order:
    //   * the last probe that found the port closed — DSH started after it, and the
    //     fast poll below keeps that within a couple of seconds;
    //   * this process's own start, which under the plugin is DSH's boot plus ~2 s.
    inferredStart = lastClosedAt
      ?? (process.env.DSH_PET_PLUGIN === '1'
        ? Date.now() - Math.round(process.uptime() * 1000)
        : Date.now());
  }

  const seconds = Math.max(0, Math.floor((Date.now() - inferredStart) / 1000));
  return {
    running: true,
    processes: info ? info.count : 1,
    seconds,
    startedAt: inferredStart,
    exePath: info ? info.exePath : null,
    hasWindow: info ? info.hasWindow : false,
    port,
  };
}

/** Bring the DSH window to the foreground, restoring it first when minimised. */
/**
 * Strong focus path for the cases the cheap paths cannot handle: a window that
 * is hidden rather than minimised, or one Windows refuses to activate.
 *
 * The window is located by title through `EnumWindows` rather than through
 * `Get-Process`, because a host process may be denied process enumeration while
 * it can always enumerate the windows on its own desktop, and Chromium windows
 * report themselves as not visible even while displayed. Raising it needs
 * `AttachThreadInput`, since Windows' foreground lock refuses a plain
 * `SetForegroundWindow` from a background process — and it verifies the result,
 * which is why it is the only path allowed to claim success.
 */
async function focusDshStrong() {
  const script = [
    "$ErrorActionPreference='Stop'",
    'try {',
    'Add-Type @"',
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public static class PetFocus {',
    '  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {',
    '    public int length; public int flags; public int showCmd;',
    '    public POINT minPosition; public POINT maxPosition; public RECT normalPosition;',
    '  }',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT p);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int c);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool SetFocus(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
    '  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr rect, IntPtr rgn, uint flags);',
    '  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);',
    '  [DllImport("dwmapi.dll")] public static extern int DwmFlush();',
    '  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);',
    '  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
    '  /// <summary>',
    '  /// Make a window that was hidden produce a fresh frame.',
    '  ///',
    '  /// Closing DSH to the background hides its window with SW_HIDE, and Chromium',
    '  /// stops compositing a hidden window. Showing it again makes the OS window',
    '  /// visible but does not make the renderer draw, so the page comes back frozen on',
    '  /// the last frame it managed to produce — the page as it looked when it was',
    '  /// closed. None of these calls change what the window looks like; they only make',
    '  /// it draw again.',
    '  /// </summary>',
    '  public static void Wake(IntPtr h) {',
    '    const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004, SWP_FRAMECHANGED = 0x0020;',
    '    const uint RDW_INVALIDATE = 0x0001, RDW_ERASE = 0x0004, RDW_FRAME = 0x0400, RDW_ALLCHILDREN = 0x0080, RDW_UPDATENOW = 0x0100;',
    '    SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);',
    '    RedrawWindow(h, IntPtr.Zero, IntPtr.Zero, RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN | RDW_UPDATENOW);',
    '    // The nudge that actually restarts a Chromium surface: a one-pixel size change',
    '    // makes the renderer re-layout and re-composite, and putting it straight back',
    '    // leaves the window exactly as it was. Skipped when maximised, where',
    '    // SetWindowPos would knock the window out of its maximised state.',
    '    if (!IsZoomed(h)) {',
    '      RECT r;',
    '      if (GetWindowRect(h, out r)) {',
    '        int w = r.Right - r.Left, ht = r.Bottom - r.Top;',
    '        SetWindowPos(h, IntPtr.Zero, 0, 0, w + 1, ht, SWP_NOMOVE | SWP_NOZORDER);',
    '        SetWindowPos(h, IntPtr.Zero, 0, 0, w, ht, SWP_NOMOVE | SWP_NOZORDER);',
    '      }',
    '    }',
    '    DwmFlush();',
    '  }',
    '',
    '  /// <summary>',
    '  /// Open DSH by clicking its tray icon from the outside.',
    '  ///',
    '  /// Closing DSH to the background hides its window with Electron win.hide(), and the',
    '  /// renderer visibility comes from Electron bookkeeping rather than the OS window,',
    '  /// so no amount of ShowWindow/RedrawWindow gets the page running again. Only the',
    '  /// app itself can, through focusPrimaryWindow() - and the tray icon is the',
    '  /// reachable way in: the tray host is a plain HWND and a click is a window message.',
    '  /// </summary>',
    '  public static bool TrayClick(IntPtr owner) {',
    '    const uint kNotifyIconMessage = 0x8001;  // WM_APP + 1',
    '    const int WM_LBUTTONDOWN = 0x0201;',
    '    if (IsWindowVisible(owner)) return true;',
    '    uint pid;',
    '    GetWindowThreadProcessId(owner, out pid);',
    '    IntPtr host = IntPtr.Zero;',
    '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
    '      uint p;',
    '      GetWindowThreadProcessId(h, out p);',
    '      if (p != pid) return true;',
    '      StringBuilder cls = new StringBuilder(256);',
    '      GetClassName(h, cls, 256);',
    '      if (cls.ToString() != "Electron_NotifyIconHostWindow") return true;',
    '      host = h;',
    '      return false;',
    '    }, IntPtr.Zero);',
    '    if (host == IntPtr.Zero) return false;',
    '    // Which id this app got is not knowable from outside, and Electron ignores a',
    '    // click on an id that owns no icon, so they are simply tried in order.',
    '    for (int id = 2; id <= 5; id++) {',
    '      SendMessage(host, kNotifyIconMessage, (IntPtr)id, (IntPtr)WM_LBUTTONDOWN);',
    '      // Handled on the app UI thread, so give it a beat before looking.',
    '      System.Threading.Thread.Sleep(300);',
    '      if (IsWindowVisible(owner)) return true;',
    '    }',
    '    return false;',
    '  }',
    '  public static IntPtr Found = IntPtr.Zero;',
    '  public static int BestScore = -1;',
    '  public static bool Look(string needle) {',
    '    Found = IntPtr.Zero;',
    '    BestScore = -1;',
    '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
    '      StringBuilder sb = new StringBuilder(512);',
    '      GetWindowText(h, sb, 512);',
    '      string t = sb.ToString();',
    '      if (t.Length == 0) return true;',
    '      if (t.StartsWith("GDI+")) return true;',
    '      if (t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;',
    '      // A minimised window reports a magic -32000 rectangle, so size has to',
    '      // be judged from the placement record instead — otherwise a minimised',
    '      // DSH looks like a 160x32 helper and gets skipped forever.',
    '      int w, hh;',
    '      WINDOWPLACEMENT wp = new WINDOWPLACEMENT();',
    '      wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));',
    '      if (GetWindowPlacement(h, ref wp) && wp.normalPosition.Right > wp.normalPosition.Left) {',
    '        w = wp.normalPosition.Right - wp.normalPosition.Left;',
    '        hh = wp.normalPosition.Bottom - wp.normalPosition.Top;',
    '      } else {',
    '        RECT r; GetWindowRect(h, out r);',
    '        w = r.Right - r.Left; hh = r.Bottom - r.Top;',
    '      }',
    '      if (w < 400 || hh < 300) return true;',
    '      // Prefer a visible window, then the largest one. IsWindowVisible is not',
    '      // trustworthy for Chromium windows, so it only ranks, never filters.',
    '      int score = (IsWindowVisible(h) ? 100000000 : 0) + w * hh;',
    '      if (score > BestScore) { BestScore = score; Found = h; }',
    '      return true;',
    '    }, IntPtr.Zero);',
    '    return Found != IntPtr.Zero;',
    '  }',
    '  public static string Force(IntPtr h) {',
    '    // Already exactly where it belongs: touch nothing at all.',
    '    //',
    '    // Every call below can make Windows flash the window taskbar button — the',
    '    // red blink — and applying them to a window that was already in front is',
    '    // precisely what triggers it. It is also the honest answer to "clicking the',
    '    // ball while DSH is already up should do nothing".',
    '    if (GetForegroundWindow() == h && IsWindowVisible(h) && !IsIconic(h)) return "already";',
    '    // Show first, then restore. Two traps live here:',
    '    //  * ShowWindow(SW_HIDE) does NOT update WINDOWPLACEMENT.showCmd, so a',
    '    //    window closed to the background still reports showCmd = SW_SHOWNORMAL;',
    '    //    only IsWindowVisible reflects it. Calling SW_SHOW on a window that is',
    '    //    already visible is a no-op, so testing visibility is safe either way.',
    '    //  * A hidden window can still be the foreground window, so success must',
    '    //    require visibility as well — otherwise focus "succeeds" and the window',
    '    //    stays exactly where it was.',
    '    bool wasHidden = !IsWindowVisible(h);',
    '    if (wasHidden) {',
    '      // Let DSH open itself the way its tray icon does: that is the only path that',
    '      // gets the renderer running again. Only if it does not answer do we fall back',
    '      // to waking the OS window, which at least makes it visible and repainting.',
    '      if (!TrayClick(h)) { ShowWindow(h, 5); Wake(h); }',
    '    }',
    '    if (IsIconic(h)) { ShowWindow(h, 9); }',
    '    IntPtr fg = GetForegroundWindow();',
    '    uint fgPid = 0;',
    '    uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out fgPid);',
    '    uint me = GetCurrentThreadId();',
    '    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);',
    '    SetForegroundWindow(h);',
    '    BringWindowToTop(h);',
    '    SetFocus(h);',
    '    if (attached) AttachThreadInput(me, fgThread, false);',
    '    // Never SwitchToThisWindow here: it toggles, so an already-active window',
    '    // gets minimised. That is what made repeated clicks hide DSH.',
    '    if (IsIconic(h)) { ShowWindow(h, 9); SetForegroundWindow(h); }',
    '    if (!IsWindowVisible(h)) { ShowWindow(h, 5); SetForegroundWindow(h); }',
    '    return (GetForegroundWindow() == h && IsWindowVisible(h)) ? (wasHidden ? "shown" : "focused") : "blocked";',
    '  }',
    '}',
    '"@',
    "  if ([PetFocus]::Look('DeepSeek Harness')) {",
    '    [PetFocus]::Force([PetFocus]::Found)',
    "  } else { 'no-window' }",
    '} catch {',
    "  'error: ' + $_.Exception.Message",
    '}',
  ].join('\n');

  const raw = (await runPowerShell(script, 20000)).trim();
  lastFocusDetail = raw.slice(0, 300) || `(no output; ${await powerShellIdentity()})`;
  lastFocusReason = classifyFocusResult(raw);
  if (process.env.PET_DEBUG) console.log('[pet:dsh] focusDshStrong ->', JSON.stringify(raw.slice(0, 160)));
  // `already` and `shown` count: DSH is in front, which is what was asked for.
  // Nothing was touched for `already`, so there is no reason to try the next route.
  return lastFocusReason === 'focused' || lastFocusReason === 'already' || lastFocusReason === 'shown';
}

/* ------------------------------------------------------------ focus helper */

let workDir = os.tmpdir();
/** Where the helper's handshake and the broker's staged scripts are written. */
function setWorkDir(dir) {
  if (dir) workDir = dir;
}

/**
 * The pet instance the helper works for — this process.
 *
 * The helper outlives the pet by design (it is detached, and it exits on its own
 * only after a long idle period), and the handshake file is a fixed path that
 * every instance reads. Without an owner recorded in that file, a new pet happily
 * adopts a leftover helper — and if that leftover was started by some other
 * process, the click inherits *that* process' token and fails, while the log
 * cheerfully says the helper is up. Recording the owner is what lets one pet say
 * "this helper is not mine" and start its own.
 */
let ownerPid = process.pid;
function setOwnerPid(pid) {
  if (pid) ownerPid = pid;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cheap liveness check for a pid we recorded ourselves. */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Raise the DSH window. Tried in order of how much privilege each route needs:
 *
 *   1. This process — works whenever the app has a full token, which is every
 *      machine where the Chromium sandbox initialises and the app starts normally.
 *   2. The focus helper — a sibling process outside Chromium that keeps a full
 *      token. It is what saves the click on the machines where the sandbox could
 *      not start and the app had to run with `--no-sandbox`. This attempt exists
 *      whether or not anything pre-started the helper: it starts one if needed,
 *      and it only ever uses a helper that belongs to this pet instance.
 *   3. A process created through the WMI service — helps on machines where the
 *      helper could not be started at all.
 */
async function focusDsh() {
  if (await focusDshStrong()) return true;
  // The same routine, precompiled: the only difference is that it needs no compiler
  // child, which is what the restricted trees refuse.
  if (await focusDshViaDll()) return true;
  if (await focusDshViaAgent()) return true;
  if (await focusDshViaBroker()) return true;
  // Last, because it is the weakest route — but the only one that still works when
  // nothing in this process tree may create the compiler child Add-Type needs.
  if (await focusDshViaCom()) return true;
  return false;
}

/* ------------------------------------------------------- helper handshake */

/**
 * The focus helper's handshake: the loopback port it listens on, the one-shot
 * token every request has to carry, and which pet instance it was started for.
 * The helper writes it once it is listening, so its absence means "nothing there".
 */
function readAgentHandshake() {
  try {
    const { port, token, pid, owner } = JSON.parse(fs.readFileSync(path.join(workDir, 'focus-agent.json'), 'utf8'));
    if (!port || !token) return null;
    return { port: Number(port), token, pid, owner: Number(owner) || null };
  } catch {
    return null;
  }
}

/**
 * Raise the DSH window using the precompiled focus routine, for the machines where
 * compiling it at runtime is impossible.
 *
 * `Add-Type` compiles by spawning a temporary `csc.exe`. On a machine forced into
 * `--no-sandbox`, everything the app starts inherits Chromium's restricted token, and
 * creating that compiler child is refused with `Access is denied` — measured, and it
 * is what made every click fail. Loading a precompiled assembly needs no compiler: the
 * bytes are handed straight to the CLR, which also sidesteps the file-path trust check
 * that `Add-Type -Path` applies to assemblies loaded from a path.
 *
 * Measured in exactly the context where `Add-Type` fails: this route loads, finds the
 * window and raises it.
 */
async function focusDshViaDll() {
  const dll = focusDllPath();
  if (!dll) return false;
  try {
    const script = [
      "$ErrorActionPreference='Stop'",
      'try {',
      `  $bytes = [IO.File]::ReadAllBytes(${psLiteral(dll)})`,
      '  $asm = [Reflection.Assembly]::Load($bytes)',
      "  if ([PetFocus]::Look('DeepSeek Harness')) { [PetFocus]::Force([PetFocus]::Found) } else { 'no-window' }",
      '} catch {',
      "  'error: ' + $_.Exception.Message",
      '}',
    ].join('\n');

    const out = (await runPowerShell(script, 20000)).trim();
    lastFocusDetail = out.slice(0, 300) || `(no output; ${await powerShellIdentity()})`;
    lastFocusReason = classifyFocusResult(out);
    if (process.env.PET_DEBUG) console.log('[pet:dsh] focusDshViaDll ->', JSON.stringify(out.slice(0, 160)));
    return lastFocusReason === 'focused' || lastFocusReason === 'already' || lastFocusReason === 'shown';
  } catch (error) {
    lastFocusDetail = 'dll threw: ' + error.message;
    return false;
  }
}

/**
 * Put the pet's own window back into the topmost band by reading the real window style
 * rather than trusting Electron.
 *
 * Measured by a tester: `setAlwaysOnTop(false)` really does clear
 * `WS_EX_TOPMOST`, and the native call behind `setAlwaysOnTop(true, 'floating')` really
 * does set it — but Chromium re-applies the window style about 0.7 ms later and the bit
 * is gone again, so the JS side alone can never hold it. This goes straight through
 * `SetWindowPos` in the shipped PetFocus.dll: read the bit, and only when it is missing
 * force `HWND_TOPMOST` with `SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE` (measured to
 * stick until the next write).
 *
 * @param {string} hwnd - window handle as a decimal string.
 * @returns {Promise<'ok'|'fixed'|'no-dll'|'error'>}
 */
async function ensureTopmost(hwnd) {
  const dll = focusDllPath();
  if (!dll || !hwnd) return 'no-dll';
  try {
    const script = [
      "$ErrorActionPreference='Stop'",
      'try {',
      `  $bytes = [IO.File]::ReadAllBytes(${psLiteral(dll)})`,
      '  $asm = [Reflection.Assembly]::Load($bytes)',
      `  if ([PetFocus]::Topmost([IntPtr][long]${hwnd})) { 'fixed' } else { 'ok' }`,
      '} catch {',
      "  'error: ' + $_.Exception.Message",
      '}',
    ].join('\n');

    const out = (await runPowerShell(script, 15000)).trim();
    if (out.startsWith('error')) {
      if (process.env.PET_DEBUG) console.log('[pet:dsh] ensureTopmost ->', out.slice(0, 160));
      return 'error';
    }
    return out === 'fixed' ? 'fixed' : 'ok';
  } catch (error) {
    if (process.env.PET_DEBUG) console.log('[pet:dsh] ensureTopmost threw ->', error.message);
    return 'error';
  }
}

/** Does the helper answer on that port? Cheaper and more honest than trusting the file. */async function agentAlive(handshake) {
  if (!handshake) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${handshake.port}/health`, {
      headers: { 'x-pet-token': handshake.token },
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Does the helper's PowerShell compile C#? Cached, because it never changes within
 * one helper's life and it costs a subprocess to find out.
 *
 * This exists because of a failure mode that is invisible otherwise: on a machine
 * where the app's process tree may not create child processes, `Add-Type` fails
 * with `Access is denied` — it compiles by spawning a temporary `csc.exe`. The
 * helper then answers `/focus` with `reason: 'error'`, which looks exactly like a
 * window problem. Asking first turns that into a logged fact.
 */
let agentCapability = null;
async function agentCompiles(handshake) {
  if (agentCapability !== null) return agentCapability;
  try {
    const script = [
      'try {',
      '  Add-Type -TypeDefinition "public static class PetCap { public static int X() { return 1; } }" -ErrorAction Stop',
      "  'capable'",
      '} catch {',
      "  'incapable: ' + $_.Exception.Message",
      '}',
    ].join('\n');
    const source = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n${script}`;
    const encoded = Buffer.from(source, 'utf16le').toString('base64');
    const out = await new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { timeout: 30000, windowsHide: true, maxBuffer: 1 << 20, encoding: 'utf8' },
        (error, stdout) => resolve(String(stdout || '')),
      );
    });
    agentCapability = out.includes('capable');
    if (!agentCapability && process.env.PET_DEBUG) {
      console.log('[pet:dsh] helper cannot compile C#:', JSON.stringify(out.trim().slice(0, 120)));
    }
  } catch {
    agentCapability = false;
  }
  return agentCapability;
}

/**
 * Raise the DSH window without compiling anything.
 *
 * Every other route needs `Add-Type`, which needs a compiler child process. On a
 * machine that refuses that, this is the only route left: `WScript.Shell`'s COM
 * `AppActivate`, which is plain user-mode automation. Weaker than the C# path — it
 * cannot un-hide a window or attach input threads — but it restores and focuses a
 * buried or minimised window, which is the common case.
 */
async function focusDshViaCom() {
  try {
    const script = [
      "$ErrorActionPreference='Continue'",
      // Match on the exact title so we cannot grab an unrelated window.
      "$ws = New-Object -ComObject WScript.Shell",
      "$ok = $ws.AppActivate('DeepSeek Harness')",
      "if ($ok) { 'com-focused' } else {",
      '  # No window under that title: fall back to the process id, which also',
      '  # restores a minimised one.',
      "  $p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |",
      "       Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
      "  if ($p) { if ($ws.AppActivate($p.Id)) { 'com-focused' } else { 'com-blocked' } }",
      "  else { 'com-no-window' }",
      '}',
    ].join('\n');
    const out = (await runPowerShell(script, 12000)).trim();
    if (out.includes('com-focused')) {
      lastFocusReason = 'focused';
      lastFocusDetail = 'com:AppActivate';
      return true;
    }
    lastFocusDetail = out.slice(0, 200) || 'com: no output';
    if (out.includes('com-no-window')) lastFocusReason = 'no-window';
    return false;
  } catch (error) {
    lastFocusDetail = 'com threw: ' + error.message;
    return false;
  }
}

/**
 * A handshake we are willing to use: it answers, it names an owner, that owner is
 * this pet instance, and the helper process it names still exists.
 *
 * The liveness test matters because a helper that has exited leaves its handshake
 * file behind. Without it the pet reports a helper as "up" purely because the file
 * is there — and the click then fails for a reason nothing in the logs explains.
 */
async function usableHandshake() {
  const handshake = readAgentHandshake();
  if (!handshake || handshake.owner !== ownerPid) return null;
  if (handshake.pid && !isProcessAlive(handshake.pid)) return null;
  if (!(await agentAlive(handshake))) return null;
  return handshake;
}

/** Ask a helper that is not ours to go away, so it cannot be picked up again. */
async function stopAgent(handshake) {
  if (!handshake) return;
  try {
    await fetch(`http://127.0.0.1:${handshake.port}/shutdown`, {
      method: 'POST',
      headers: { 'x-pet-token': handshake.token },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* already gone, or unreachable — either way there is nothing to reuse */
  }
}

let startingAgent = null;

/**
 * Start the focus helper if this pet instance does not already have a live one.
 *
 * This used to belong to tools/launch.cjs alone, which worked only when running
 * from source — and that is exactly the bug in the packaged build: the exe has no
 * launcher, so nothing ever started the helper, the handshake file was never
 * written, and every click fell through to the pet's own sandbox-restricted
 * attempt and failed. Clicking the ball therefore did nothing at all.
 *
 * Two details make this work in a packaged app:
 *
 *   * Electron's own binary is the only Node runtime guaranteed to exist on a
 *     machine that has this app, so it is started through `process.execPath` with
 *     `ELECTRON_RUN_AS_NODE=1` — the same binary, as a plain Node interpreter.
 *     (Without that variable it would try to start a second copy of the pet.)
 *   * Nothing else is passed on the command line. In particular NOT `--no-sandbox`:
 *     that is a Chromium switch, and with `ELECTRON_RUN_AS_NODE=1` the binary is
 *     plain Node, which rejects the flag outright with `bad option: --no-sandbox`
 *     and exits before the helper can do anything. Verified by running it.
 *     The sandbox only matters for the pet's own Chromium process, which is why
 *     the launcher's own helper start (no flags either) has always worked.
 *
 * Resolves to the handshake, or null when the helper could not be started at all
 * (in which case the caller falls through to its own attempts).
 */
async function startFocusAgent() {
  if (startingAgent) return startingAgent;
  startingAgent = (async () => {
    const mine = await usableHandshake();
    if (mine) return mine;

    // Whatever is in the file is either stale or belongs to another instance (for
    // example a leftover from a pet that was force-quit, whose detached helper is
    // still listening). Retire it before overwriting the file, so nothing can come
    // back and adopt it later.
    const foreign = readAgentHandshake();
    if (foreign && foreign.owner !== ownerPid) await stopAgent(foreign);

    // A different helper means a possibly different environment (for example the
    // launcher's helper versus one this process started), so re-probe.
    agentCapability = null;

    const script = path.join(__dirname, '..', 'tools', 'focus-agent.cjs');
    if (!fs.existsSync(script)) return null;
    try {
      const child = spawn(
        process.execPath,
        [script],
        {
          // The helper's absolute handshake path, so it lands where this process
          // reads it no matter what userData directory the pet was started with —
          // and the owner pid, so only this instance will adopt it.
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            DSH_PET_STATE_DIR: workDir,
            DSH_PET_OWNER_PID: String(ownerPid),
          },
          detached: true,
          stdio: 'ignore',
        },
      );
      child.unref();
    } catch {
      return null;
    }

    // It is listening within a few tens of milliseconds; this is only long enough
    // to cover process start-up, never a hang.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(80);
      const started = await usableHandshake();
      if (started) return started;
    }
    return null;
  })().finally(() => {
    startingAgent = null;
  });
  return startingAgent;
}

/**
 * Ask the focus helper — which runs outside Chromium and therefore keeps a full
 * token — to raise the DSH window. This is what makes the click work on the
 * machines where the pet itself is sandbox-restricted, and it is also what makes
 * a packaged build work at all, since nothing else starts the helper there.
 *
 * Only this instance's own helper is ever used; see startFocusAgent.
 */
async function focusDshViaAgent() {
  try {
    const handshake = (await usableHandshake()) || (await startFocusAgent());
    if (!handshake) return false;
    // A helper that cannot compile C# cannot focus anything, and asking it would
    // only produce a misleading `reason: 'error'`. Report it and let the weaker
    // routes (which need no compiler) have the turn.
    if (!(await agentCompiles(handshake))) return false;

    const response = await fetch(`http://127.0.0.1:${handshake.port}/focus`, {
      method: 'POST',
      headers: { 'x-pet-token': handshake.token },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    if (typeof payload.reason === 'string') lastFocusReason = payload.reason;
    else if (payload.ok !== true) lastFocusReason = 'blocked';
    if (typeof payload.detail === 'string' && payload.detail) lastFocusDetail = payload.detail;
    if (process.env.PET_DEBUG) console.log('[pet:dsh] focusDshViaAgent ->', JSON.stringify(payload));
    return payload.ok === true;
  } catch (error) {
    if (process.env.PET_DEBUG) console.log('[pet:dsh] focusDshViaAgent ->', error.message);
    return false;
  }
}

/** Tell our helper to stop; called when the pet quits. */
async function stopFocusAgent() {
  await stopAgent(readAgentHandshake());
}

/* ------------------------------------------------------------ focus reason */

/**
 * Why the last focus attempt ended the way it did:
 * `focused` | `no-window` | `blocked` | `error`.
 *
 * `openDsh` needs the difference: a window that exists but refuses to come
 * forward must never be "fixed" by starting a second copy, whereas a DSH that
 * is running with no window at all can only be recovered by starting one.
 */
let lastFocusReason = 'unknown';
/**
 * What the focus routine's PowerShell actually printed, kept for diagnostics.
 *
 * `reason: 'error'` on its own says nothing: the useful part is the message
 * (`Access is denied` from Add-Type means a token problem, not a window problem).
 * It goes into the log and into what the helper reports back.
 */
let lastFocusDetail = '';
function focusReason() {
  return lastFocusReason;
}
function focusDetail() {
  return lastFocusDetail;
}
function classifyFocusResult(result) {
  // `already` means DSH was in front the whole time and nothing was touched — the
  // requested "clicking the ball while DSH is up does nothing" case. It is a
  // success, and deliberately not reported as a focus change.
  if (result.includes('already')) return 'already';
  // `shown` means the window had been closed to the background and this call only
  // un-hid it at the OS level — see the note in openDsh about why that is not enough.
  if (result.includes('shown')) return 'shown';
  if (result.includes('focused')) return 'focused';
  if (result.includes('no-window')) return 'no-window';
  if (result.includes('error:')) return 'error';
  return 'blocked';
}

/* ------------------------------------------------------------------ broker */

/** The thorough focus routine, as a standalone ASCII-only PowerShell script. */
const BROKER_PS = [
  "$ErrorActionPreference='Stop'",
  'try {',
  'Add-Type @"',
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public static class PetFocusBroker {',
  '  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {',
  '    public int length; public int flags; public int showCmd;',
  '    public POINT minPosition; public POINT maxPosition; public RECT normalPosition;',
  '  }',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT p);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int c);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool SetFocus(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
  '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
  '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr rect, IntPtr rgn, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);',
  '  [DllImport("dwmapi.dll")] public static extern int DwmFlush();',
  '  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);',
  '  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  // Bring a window that was hidden back to life; see the note in the inline copy.',
  '  public static void Wake(IntPtr h) {',
  '    const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOZORDER = 0x0004, SWP_FRAMECHANGED = 0x0020;',
  '    const uint RDW_INVALIDATE = 0x0001, RDW_ERASE = 0x0004, RDW_FRAME = 0x0400, RDW_ALLCHILDREN = 0x0080, RDW_UPDATENOW = 0x0100;',
  '    SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);',
  '    RedrawWindow(h, IntPtr.Zero, IntPtr.Zero, RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN | RDW_UPDATENOW);',
  '    if (!IsZoomed(h)) {',
  '      RECT r;',
  '      if (GetWindowRect(h, out r)) {',
  '        int w = r.Right - r.Left, ht = r.Bottom - r.Top;',
  '        SetWindowPos(h, IntPtr.Zero, 0, 0, w + 1, ht, SWP_NOMOVE | SWP_NOZORDER);',
  '        SetWindowPos(h, IntPtr.Zero, 0, 0, w, ht, SWP_NOMOVE | SWP_NOZORDER);',
  '      }',
  '    }',
  '    DwmFlush();',
  '  }',
  '',
  '  /// <summary>',
  '  /// Open DSH by clicking its tray icon from the outside.',
  '  ///',
  '  /// Closing DSH to the background hides its window with Electron win.hide(), and the',
  '  /// renderer visibility comes from Electron bookkeeping rather than the OS window,',
  '  /// so no amount of ShowWindow/RedrawWindow gets the page running again. Only the',
  '  /// app itself can, through focusPrimaryWindow() - and the tray icon is the',
  '  /// reachable way in: the tray host is a plain HWND and a click is a window message.',
  '  /// </summary>',
  '  public static bool TrayClick(IntPtr owner) {',
  '    const uint kNotifyIconMessage = 0x8001;  // WM_APP + 1',
  '    const int WM_LBUTTONDOWN = 0x0201;',
  '    if (IsWindowVisible(owner)) return true;',
  '    uint pid;',
  '    GetWindowThreadProcessId(owner, out pid);',
  '    IntPtr host = IntPtr.Zero;',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      uint p;',
  '      GetWindowThreadProcessId(h, out p);',
  '      if (p != pid) return true;',
  '      StringBuilder cls = new StringBuilder(256);',
  '      GetClassName(h, cls, 256);',
  '      if (cls.ToString() != "Electron_NotifyIconHostWindow") return true;',
  '      host = h;',
  '      return false;',
  '    }, IntPtr.Zero);',
  '    if (host == IntPtr.Zero) return false;',
  '    // Which id this app got is not knowable from outside, and Electron ignores a',
  '    // click on an id that owns no icon, so they are simply tried in order.',
  '    for (int id = 2; id <= 5; id++) {',
  '      SendMessage(host, kNotifyIconMessage, (IntPtr)id, (IntPtr)WM_LBUTTONDOWN);',
  '      // Handled on the app UI thread, so give it a beat before looking.',
  '      System.Threading.Thread.Sleep(300);',
  '      if (IsWindowVisible(owner)) return true;',
  '    }',
  '    return false;',
  '  }',
  '  public static IntPtr Found = IntPtr.Zero;',
  '  public static int BestScore = -1;',
  '  public static bool Look(string needle) {',
  '    Found = IntPtr.Zero;',
  '    BestScore = -1;',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      StringBuilder sb = new StringBuilder(512);',
  '      GetWindowText(h, sb, 512);',
  '      string t = sb.ToString();',
  '      if (t.Length == 0) return true;',
  '      if (t.StartsWith("GDI+")) return true;',
  '      if (t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;',
  '      // Judge size from the placement record: a minimised window reports a',
  '      // magic -32000 rectangle and would otherwise be skipped forever.',
  '      int w, hh;',
  '      WINDOWPLACEMENT wp = new WINDOWPLACEMENT();',
  '      wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));',
  '      if (GetWindowPlacement(h, ref wp) && wp.normalPosition.Right > wp.normalPosition.Left) {',
  '        w = wp.normalPosition.Right - wp.normalPosition.Left;',
  '        hh = wp.normalPosition.Bottom - wp.normalPosition.Top;',
  '      } else {',
  '        RECT r; GetWindowRect(h, out r);',
  '        w = r.Right - r.Left; hh = r.Bottom - r.Top;',
  '      }',
  '      if (w < 400 || hh < 300) return true;',
  '      // Prefer a visible window, then the largest one. IsWindowVisible is not',
  '      // trustworthy for Chromium windows, so it only ranks, never filters.',
  '      int score = (IsWindowVisible(h) ? 100000000 : 0) + w * hh;',
  '      if (score > BestScore) { BestScore = score; Found = h; }',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return Found != IntPtr.Zero;',
  '  }',
  '  public static string Force(IntPtr h) {',
  '    // Already in front: touch nothing, so nothing can flash. See the note in the',
  '    // inline copy of this routine.',
  '    if (GetForegroundWindow() == h && IsWindowVisible(h) && !IsIconic(h)) return "already";',
  '    // Show, then restore, then verify visibility as well as foreground; see the',
  '    // note in the inline copy of this routine for the two traps involved.',
  '    bool wasHidden = !IsWindowVisible(h);',
  '    if (wasHidden) {',
  '      // Let DSH open itself the way its tray icon does: that is the only path that',
  '      // gets the renderer running again. Only if it does not answer do we fall back',
  '      // to waking the OS window, which at least makes it visible and repainting.',
  '      if (!TrayClick(h)) { ShowWindow(h, 5); Wake(h); }',
  '    }',
  '    if (IsIconic(h)) { ShowWindow(h, 9); }',
  '    IntPtr fg = GetForegroundWindow();',
  '    uint fgPid = 0;',
  '    uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out fgPid);',
  '    uint me = GetCurrentThreadId();',
  '    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);',
  '    SetForegroundWindow(h);',
  '    BringWindowToTop(h);',
  '    SetFocus(h);',
  '    if (attached) AttachThreadInput(me, fgThread, false);',
  '    if (IsIconic(h)) { ShowWindow(h, 9); SetForegroundWindow(h); }',
  '    if (!IsWindowVisible(h)) { ShowWindow(h, 5); SetForegroundWindow(h); }',
  '    return (GetForegroundWindow() == h && IsWindowVisible(h)) ? (wasHidden ? "shown" : "focused") : "blocked";',
  '  }',
  '}',
  '"@',
  "  if ([PetFocusBroker]::Look('DeepSeek Harness')) {",
  '    [PetFocusBroker]::Force([PetFocusBroker]::Found)',
  "  } else { 'no-window' }",
  '} catch {',
  "  'error: ' + $_.Exception.Message",
  '}',
].join('\n');

/** Quote a string for embedding in a PowerShell single-quoted literal. */
function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Run the focus routine through a process created by the WMI service, which
 * gets a clean token instead of this process' restricted one.
 */
async function focusDshViaBroker() {
  try {
    const scriptFile = path.join(workDir, 'focus-broker.ps1');
    const outFile = path.join(workDir, 'focus-broker.out');
    fs.writeFileSync(scriptFile, BROKER_PS, 'utf8');
    fs.rmSync(outFile, { force: true });

    const inner = `cmd.exe /c powershell.exe -NoProfile -NonInteractive `
      + `-ExecutionPolicy Bypass -File "${scriptFile}" > "${outFile}" 2>&1`;
    const traceFile = `${scriptFile}.launch.log`;
    const launcher = [
      "$ErrorActionPreference='Continue'",
      `$cmd = ${psLiteral(inner)}`,
      "$result = ''",
      'try {',
      '  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd } -ErrorAction Stop',
      "  $result = 'cim rv=' + $r.ReturnValue + ' pid=' + $r.ProcessId",
      '} catch {',
      "  $result = 'cim threw: ' + $_.Exception.Message",
      '}',
      `$result | Out-File -Encoding UTF8 -FilePath ${psLiteral(traceFile)}`,
    ].join('\n');

    await runPowerShell(launcher, 12000);
    if (process.env.PET_DEBUG) {
      let trace = '(no trace)';
      try { trace = fs.readFileSync(traceFile, 'utf8').trim(); } catch { /* ignore */ }
      console.log('[pet:dsh] broker launch ->', trace);
    }

    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await sleep(250);
      if (!fs.existsSync(outFile)) continue;
      const text = fs.readFileSync(outFile, 'utf8');
      if (text.includes('focused') || text.includes('already')) {
        lastFocusReason = text.includes('already') ? 'already' : 'focused';
        if (process.env.PET_DEBUG) console.log('[pet:dsh] focusDshViaBroker ->', lastFocusReason);
        return true;
      }
      if (text.includes('no-window') || text.includes('error:')) {
        if (process.env.PET_DEBUG) {
          console.log('[pet:dsh] focusDshViaBroker ->', JSON.stringify(text.trim().slice(0, 140)));
        }
        return false;
      }
    }
    if (process.env.PET_DEBUG) console.log('[pet:dsh] focusDshViaBroker -> timed out');
    return false;
  } catch (error) {
    if (process.env.PET_DEBUG) console.log('[pet:dsh] focusDshViaBroker threw', error.message);
    return false;
  }
}

function resolveExe(exePath) {
  if (exePath && fs.existsSync(exePath)) return exePath;
  // The static candidates first, since they cost nothing, then the installer's own
  // record — the only thing that finds an install outside those locations.
  for (const candidate of [...EXE_CANDIDATES, ...installedDshExes()]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Click behaviour: raise the running DSH window, or start DSH when it is closed.
 *
 * Deliberately one-way: when DSH is already running we NEVER start another copy.
 * A second launch reaches the running app as `second-instance`, and DSH's handler
 * for that does not raise the window — so the click looked like it did nothing at
 * best, and at worst left the window in a state the next click could not recover.
 * Reporting the failure lets the UI say so instead.
 *
 * "Running" covers three cases, and the focus script tells them apart: already in
 * front (`already`, nothing is touched at all), just buried or minimised
 * (`focused`), or closed to the background (`shown`, which the script answers by
 * clicking DSH's tray icon — the app's own way back).
 *
 * @returns {Promise<{action:'focused'|'focus-failed'|'launched'|'failed', detail?:string}>}
 */
async function openDsh(probe) {
  const info = probe || (await probeDsh());
  if (info.running) {
    if (await focusDsh()) {
      // Record when nothing was touched: DSH was already in front, so the click
      // deliberately did nothing to it.
      if (lastFocusReason === 'shown') {
        // The window had been closed to the background. DSH's X hides it with
        // Electron's own `win.hide()`, so the renderer still believes it is hidden and
        // keeps the page's JavaScript parked — the window paints (hover effects work,
        // which is what made this look like a frozen frame at first) but the page is
        // not running. No outside call can undo that: `ShowWindow` and friends only
        // change the OS window, while the renderer's visibility comes from Electron's
        // bookkeeping.
        //
        // The focus script therefore clicked DSH's tray icon, which is the app's own
        // `focusPrimaryWindow()` → `win.show()`. Nothing more to do here; relaunching
        // DSH was tried first and does not work (its `second-instance` handler runs
        // that same function but does not get the window back).
        return { action: 'focused', detail: '已从后台打开（用 DSH 托盘图标的路径）' };
      }
      return {
        action: 'focused',
        detail: lastFocusReason === 'already' ? '已经在前台，未做任何操作' : undefined,
      };
    }
    // Running with no window left to raise (the window was closed and destroyed
    // while the process stayed alive): starting it again is the only way back.
    if (lastFocusReason === 'no-window') {
      const exe = resolveExe(info.exePath);
      if (exe) {
        try {
          spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
          return { action: 'launched' };
        } catch (error) {
          return { action: 'failed', detail: error.message };
        }
      }
    }
    return {
      action: 'focus-failed',
      detail: `DSH 在运行，但没能把它的窗口提到最前（${lastFocusReason}${lastFocusDetail ? ': ' + lastFocusDetail : ''}）`,
    };
  }
  const exe = resolveExe(info.exePath);
  if (!exe) return { action: 'failed', detail: '没有找到 DeepSeek Harness 可执行文件' };
  try {
    spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { action: 'launched' };
  } catch (error) {
    return { action: 'failed', detail: error.message };
  }
}
module.exports = {
  probeDsh,
  openDsh,
  readBalance,
  focusDsh,
  focusDshStrong,
  focusDshViaDll,
  ensureTopmost,
  focusDshViaBroker,
  focusDshViaAgent,
  focusDshViaCom,
  focusReason,
  focusDetail,
  startFocusAgent,
  stopFocusAgent,
  setWorkDir,
  setOwnerPid,
  runPowerShell,
  installedDshExes,
  DSH_HOME,
};
