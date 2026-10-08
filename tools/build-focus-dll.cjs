'use strict';
/**
 * Build the precompiled focus routine: build/PetFocus.dll.
 *
 * Why this exists: raising a window needs P/Invoke, and the usual way to get it —
 * `Add-Type` inside PowerShell — compiles by spawning a temporary `csc.exe`. On the
 * machines this app has to run on, the app is forced into `--no-sandbox`, everything
 * it starts inherits Chromium's restricted token, and creating that compiler child is
 * refused (`Access is denied`). Measured consequence: every click failed.
 *
 * A precompiled assembly needs no compiler at runtime — the bytes are handed to the
 * CLR — so the focus routine keeps working where `Add-Type` cannot. Verified in
 * exactly that restricted context, where this DLL still found the window and raised it.
 *
 * Run before packaging (assemble.cjs does it automatically).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');
const DLL = path.join(OUT_DIR, 'PetFocus.dll');

// Must stay behaviourally identical to the inline routine in src/dsh.js
// (focusDshStrong), including the "already" short-circuit that stops Windows from
// flashing the taskbar button, and the hidden-window handling.
const CS = [
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public static class PetFocus {',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct WP { public int length, flags, showCmd; public POINT min, max; public RECT normal; }',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WP p);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool SetFocus(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool at);',
  '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '  public static IntPtr Found = IntPtr.Zero;',
  '  public static int Best = -1;',
  '  /// <summary>Pick the best window whose title contains the needle.</summary>',
  '  public static bool Look(string needle) {',
  '    Found = IntPtr.Zero; Best = -1;',
  '    EnumWindows(delegate(IntPtr h, IntPtr l) {',
  '      StringBuilder sb = new StringBuilder(512);',
  '      GetWindowText(h, sb, 512);',
  '      string t = sb.ToString();',
  '      if (t.Length == 0) return true;',
  '      if (t.StartsWith("GDI+")) return true;',
  '      if (t.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;',
  '      // A minimised window reports a sentinel rectangle, so judge size from the',
  '      // placement record instead - otherwise it looks like a small helper window.',
  '      int w, hh;',
  '      WP wp = new WP();',
  '      wp.length = Marshal.SizeOf(typeof(WP));',
  '      if (GetWindowPlacement(h, ref wp) && wp.normal.R > wp.normal.L) {',
  '        w = wp.normal.R - wp.normal.L; hh = wp.normal.B - wp.normal.T;',
  '      } else { RECT r; GetWindowRect(h, out r); w = r.R - r.L; hh = r.B - r.T; }',
  '      if (w < 400 || hh < 300) return true;',
  '      int score = (IsWindowVisible(h) ? 100000000 : 0) + w * hh;',
  '      if (score > Best) { Best = score; Found = h; }',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return Found != IntPtr.Zero;',
  '  }',
  '  /// <summary>Show, restore and focus. Returns already|shown|focused|blocked.</summary>',
  '  public static string Force(IntPtr h) {',
  '    // Already in front: touch nothing, so Windows cannot flash the taskbar button.',
  '    if (GetForegroundWindow() == h && IsWindowVisible(h) && !IsIconic(h)) return "already";',
  '    bool hidden = !IsWindowVisible(h);',
  '    if (hidden) ShowWindow(h, 5);',
  '    if (IsIconic(h)) ShowWindow(h, 9);',
  '    IntPtr fg = GetForegroundWindow();',
  '    uint fgPid = 0;',
  '    uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out fgPid);',
  '    uint me = GetCurrentThreadId();',
  '    bool at = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);',
  '    SetForegroundWindow(h); BringWindowToTop(h); SetFocus(h);',
  '    if (at) AttachThreadInput(me, fgThread, false);',
  '    // Never SwitchToThisWindow: it toggles, so an active window gets minimised.',
  '    if (IsIconic(h)) { ShowWindow(h, 9); SetForegroundWindow(h); }',
  '    if (!IsWindowVisible(h)) { ShowWindow(h, 5); SetForegroundWindow(h); }',
  '    return (GetForegroundWindow() == h && IsWindowVisible(h)) ? (hidden ? "shown" : "focused") : "blocked";',
  '  }',
  '}',
].join('\n');

function build() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(DLL, { force: true });
  const script = [
    'Add-Type -TypeDefinition @"',
    CS,
    '"@ -OutputAssembly "' + DLL + '" -ErrorAction Stop',
    "'built'",
  ].join('\n');
  const encoded = Buffer.from(`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', timeout: 120000 }).trim();
  if (!fs.existsSync(DLL)) throw new Error('Add-Type did not produce ' + DLL + ' (' + out + ')');
  return fs.statSync(DLL).size;
}

if (require.main === module) {
  const size = build();
  console.log('focus DLL built:', DLL, '(' + size + ' bytes)');
}

module.exports = { build, DLL, CS };
