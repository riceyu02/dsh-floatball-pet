'use strict';
/**
 * One-off patch: teach both embedded focus scripts to open DSH by clicking its tray
 * icon from the outside.
 *
 * Why: closing DSH to the background hides its window with Electron's `win.hide()`,
 * and the renderer's visibility comes from Electron's bookkeeping rather than from
 * the OS window — so `ShowWindow` / `RedrawWindow` / `SetWindowPos` can make the
 * window visible and repainting but never get the page's JavaScript running again.
 * The only thing that does is the app's own `focusPrimaryWindow()` → `win.show()`,
 * and the reachable way to trigger it from outside is the tray icon: the tray host is
 * a plain HWND and a click is just a window message.
 *
 * The protocol is from electron/shell/browser/ui/win/notify_icon_host.cc:
 *   kNotifyIconMessage = WM_APP + 1      (0x8001)
 *   kBaseIconId        = 2               (NextIconId() returns kBaseIconId + n, so a
 *                                         single tray icon usually ends up as 3)
 *   a left click arrives as WM_LBUTTONDOWN (0x0201), not WM_LBUTTONUP
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'dsh.js');
let src = fs.readFileSync(file, 'utf8');
const EOL = src.includes('\r\n') ? '\r\n' : '\n';
console.log('line endings:', JSON.stringify(EOL));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace a block of C# source lines. The lines are matched without their leading
 * indentation, and the indentation found in the file is re-applied to every line
 * after the first — so the same patch works in both copies of the script, which are
 * indented differently.
 */
function replaceBlock(label, inLines, outLines) {
  const out = outLines || inLines;
  const pattern = new RegExp(
    inLines.map((l, i) => (i === 0 ? '' : '(\\s*)') + escapeRe(l)).join('\\r?\\n'), 'g');
  let n = 0;
  src = src.replace(pattern, (...rest) => {
    n += 1;
    const indent = rest[1] || '';
    return out.map((l, i) => (i === 0 ? l : indent + l)).join(EOL);
  });
  if (n === 0) throw new Error('anchor missing: ' + label);
  console.log('  ' + label + ': ' + n + ' match(es)');
}

/* 1 ---------------------------------------------------------- extra P/Invokes */
replaceBlock('P/Invokes', [
  "'  [DllImport(\"dwmapi.dll\")] public static extern int DwmFlush();',",
], [
  "'  [DllImport(\"dwmapi.dll\")] public static extern int DwmFlush();',",
  "'  [DllImport(\"user32.dll\")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);',",
  "'  [DllImport(\"user32.dll\")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',",
]);

/* 2 ------------------------------------------------------------ TrayClick body */
replaceBlock('TrayClick', [
  "'    DwmFlush();',",
  "'  }',",
], [
  "'    DwmFlush();',",
  "'  }',",
  "'',",
  "'  /// <summary>',",
  "'  /// Open DSH by clicking its tray icon from the outside.',",
  "'  ///',",
  "'  /// Closing DSH to the background hides its window with Electron win.hide(), and the',",
  "'  /// renderer visibility comes from Electron bookkeeping rather than the OS window,',",
  "'  /// so no amount of ShowWindow/RedrawWindow gets the page running again. Only the',",
  "'  /// app itself can, through focusPrimaryWindow() - and the tray icon is the',",
  "'  /// reachable way in: the tray host is a plain HWND and a click is a window message.',",
  "'  /// </summary>',",
  "'  public static bool TrayClick(IntPtr owner) {',",
  "'    const uint kNotifyIconMessage = 0x8001;  // WM_APP + 1',",
  "'    const int WM_LBUTTONDOWN = 0x0201;',",
  "'    if (IsWindowVisible(owner)) return true;',",
  "'    uint pid;',",
  "'    GetWindowThreadProcessId(owner, out pid);',",
  "'    IntPtr host = IntPtr.Zero;',",
  "'    EnumWindows(delegate(IntPtr h, IntPtr l) {',",
  "'      uint p;',",
  "'      GetWindowThreadProcessId(h, out p);',",
  "'      if (p != pid) return true;',",
  "'      StringBuilder cls = new StringBuilder(256);',",
  "'      GetClassName(h, cls, 256);',",
  "'      if (cls.ToString() != \"Electron_NotifyIconHostWindow\") return true;',",
  "'      host = h;',",
  "'      return false;',",
  "'    }, IntPtr.Zero);',",
  "'    if (host == IntPtr.Zero) return false;',",
  "'    // Which id this app got is not knowable from outside, and Electron ignores a',",
  "'    // click on an id that owns no icon, so they are simply tried in order.',",
  "'    for (int id = 2; id <= 5; id++) {',",
  "'      SendMessage(host, kNotifyIconMessage, (IntPtr)id, (IntPtr)WM_LBUTTONDOWN);',",
  "'      // Handled on the app UI thread, so give it a beat before looking.',",
  "'      System.Threading.Thread.Sleep(300);',",
  "'      if (IsWindowVisible(owner)) return true;',",
  "'    }',",
  "'    return false;',",
  "'  }',",
]);

/* 3 --------------------------------------------------- use it when it was hidden */
replaceBlock('hidden path', [
  "'    bool wasHidden = !IsWindowVisible(h);',",
  "'    if (wasHidden) { ShowWindow(h, 5); }',",
  "'    if (IsIconic(h)) { ShowWindow(h, 9); }',",
  "'    if (wasHidden) { Wake(h); }',",
], [
  "'    bool wasHidden = !IsWindowVisible(h);',",
  "'    if (wasHidden) {',",
  "'      // Let DSH open itself the way its tray icon does: that is the only path that',",
  "'      // gets the renderer running again. Only if it does not answer do we fall back',",
  "'      // to waking the OS window, which at least makes it visible and repainting.',",
  "'      if (!TrayClick(h)) { ShowWindow(h, 5); Wake(h); }',",
  "'    }',",
  "'    if (IsIconic(h)) { ShowWindow(h, 9); }',",
]);

fs.writeFileSync(file, src);
console.log('patched src/dsh.js');
