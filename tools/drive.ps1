# Drive the floating ball for verification.
#
# The pet's debug log reports everything needed to aim precisely: the cursor in
# window-local DIP, the window's own DIP bounds, the ball box, the rendered ball
# size, the measured island width, the panel box and the layout constants. The
# screen scale is derived from the real window rect, so the physical pixels the
# Win32 mouse API wants can be computed exactly.
#
# This file is deliberately pure ASCII: Windows PowerShell 5.1 reads BOM-less
# scripts as ANSI, and a non-ASCII literal would then swallow the following quote
# and break parsing. The pet's window is therefore located by process name, and
# its log directory by discovery rather than by a hard-coded name.
#
#   powershell -ExecutionPolicy Bypass -File drive.ps1 -Action hover
param(
  [Parameter(Mandatory = $true)][ValidateSet('away', 'hover', 'click', 'gear', 'size-low', 'size-high')][string]$Action
)

$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class PetInput {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, uint e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public static IntPtr Found = IntPtr.Zero;
  // The pet is the only top-level window owned by an "electron" process.
  public static bool LookElectron() {
    Found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      StringBuilder sb = new StringBuilder(512);
      if (GetWindowText(h, sb, 512) == 0 || sb.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      try { if (Process.GetProcessById((int)pid).ProcessName == "electron") { Found = h; return false; } }
      catch { }
      return true;
    }, IntPtr.Zero);
    return Found != IntPtr.Zero;
  }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Down() { mouse_event(LEFTDOWN, 0, 0, 0, 0); }
  public static void Up() { mouse_event(LEFTUP, 0, 0, 0, 0); }
  public static void Click() { Down(); System.Threading.Thread.Sleep(80); Up(); }
}
"@
[PetInput]::SetProcessDPIAware() | Out-Null

$logPath = $env:DSH_PET_LOG
if (-not $logPath -or -not (Test-Path $logPath)) {
  $dir = Get-ChildItem $env:APPDATA -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'pet.log') } | Select-Object -First 1
  if (-not $dir) { throw 'pet.log not found under APPDATA' }
  $logPath = Join-Path $dir.FullName 'pet.log'
}
Write-Host "log: $logPath"

function ReadGeom() {
  $script:line = (Get-Content $logPath | Select-String 'poll local=' | Select-Object -Last 1).Line
  if (-not $script:line) { throw 'no poll line; start the pet with PET_DEBUG=1' }
  function Field([string]$pattern) { return [regex]::Match($script:line, $pattern) }
  $script:ballM   = Field 'ball=\((-?\d+),(-?\d+),(\d+)\)'
  $script:bndM    = Field 'bounds=\((-?\d+),(-?\d+),(\d+)x(\d+)\)'
  $script:sizeM   = Field 'size=([\d.]+)'
  $script:islandM = Field 'island=(\d+)'
  $script:panelM  = Field 'panel=(\d+)x(\d+)'
  $script:padM    = Field 'pad=(\d+)'
  $script:gapM    = Field 'gap=(\d+)'
  if (-not $script:ballM.Success -or -not $script:bndM.Success) { throw "unparsable: $script:line" }

  $script:winW = [int]$script:bndM.Groups[3].Value
  $script:winH = [int]$script:bndM.Groups[4].Value
  $script:pad = [int]$script:padM.Groups[1].Value
  $script:gap = [int]$script:gapM.Groups[1].Value
  $script:size = [double]$script:sizeM.Groups[1].Value
  $script:island = [int]$script:islandM.Groups[1].Value
  $script:panelW = [int]$script:panelM.Groups[1].Value
  $script:panelH = [int]$script:panelM.Groups[2].Value

  # The log carries the side the app actually chose. Deriving it from the ball's
  # window-local x no longer works: the ball sits at a fixed spot in the window
  # whichever way the island unfolds, so it is always left of centre.
  $script:sideM = Field 'side=(left|right)'
  $script:sideRight = -not ($script:sideM.Success -and $script:sideM.Groups[1].Value -eq 'left')
  $script:orbLeft = [int]$script:ballM.Groups[1].Value + 4      # box is inflated by HOVER_SLACK/2
  $script:capTop = [int]$script:ballM.Groups[2].Value + 4
  $script:ballCx = $script:orbLeft + $script:size / 2
  $script:ballCy = $script:capTop + $script:size / 2

  $script:gearSize = [Math]::Min(36, [Math]::Max(20, $script:size * 0.46))
  $script:islandOuter = if ($script:sideRight) { $script:orbLeft + $script:size + $script:island }
                        else { $script:orbLeft - $script:island }
  $script:gearCx = if ($script:sideRight) { $script:islandOuter - $script:size * 0.17 - $script:gearSize / 2 }
                   else { $script:islandOuter + $script:size * 0.17 + $script:gearSize / 2 }

  $script:panelLeft = if ($script:sideRight) { $script:pad } else { $script:winW - $script:pad - $script:panelW }
  # A hidden panel is measured through its 0.965 entry transform, so the reported
  # height is a touch small; the shown height is what positions the rows.
  $script:panelHShown = [Math]::Max($script:panelH, [Math]::Round($script:panelH / 0.965))
  $script:panelTop = $script:capTop - $script:gap - $script:panelHShown

  [PetInput]::LookElectron() | Out-Null
  if ([PetInput]::Found -eq [IntPtr]::Zero) { throw 'pet window not found' }
  $script:rect = New-Object PetInput+RECT
  [PetInput]::GetWindowRect([PetInput]::Found, [ref]$script:rect) | Out-Null
  $script:scale = ($script:rect.Right - $script:rect.Left) / [double]$script:winW
  if ($script:scale -le 0) { $script:scale = 1 }
}

function PhysX([double]$dip) { return [int]($script:rect.Left + $dip * $script:scale) }
function PhysY([double]$dip) { return [int]($script:rect.Top + $dip * $script:scale) }

function MoveAway() {
  # parking the cursor closes the panel after its idle timeout
  [PetInput]::Move(2380, 150); Start-Sleep -Milliseconds 1400
}

function OpenPanel() {
  [PetInput]::Move((PhysX $script:ballCx), (PhysY $script:ballCy)); Start-Sleep -Milliseconds 900
  [PetInput]::Move((PhysX $script:gearCx), (PhysY $script:ballCy)); Start-Sleep -Milliseconds 350
  [PetInput]::Click(); Start-Sleep -Milliseconds 1400
}

function DragSize([double]$targetDipX) {
  ReadGeom   # the window grew when the panel opened; use the live geometry
  # The size slider's track sits 76dp below the panel's top edge: 13 padding +
  # 22 header + 11 gap + 15 label + 5 gap + half of the 18px range input.
  $rowY = PhysY ($script:panelTop + 76)
  $fromX = PhysX ($script:panelLeft + 14 + ($script:panelW - 28) * 0.5)
  $toX = PhysX $targetDipX
  Write-Host ("drag: winTop={0} panelTop={1} rowY={2}  x {3} -> {4}" -f $script:rect.Top, $script:panelTop, $rowY, $fromX, $toX)
  [PetInput]::Move($fromX, $rowY); Start-Sleep -Milliseconds 300; [PetInput]::Down()
  for ($i = 1; $i -le 26; $i++) {
    [PetInput]::Move([int]($fromX + ($toX - $fromX) * $i / 26.0), $rowY)
    Start-Sleep -Milliseconds 35
  }
  [PetInput]::Up(); Write-Host 'slider dragged'
}

MoveAway
ReadGeom

Write-Host ("window DIP {0}x{1} at ({2},{3}) scale {3} side={4}" -f `
  $winW, $winH, $bndM.Groups[1].Value, $scale, $(if ($sideRight) { 'right' } else { 'left' }))
Write-Host ("ball DIP ({0},{1}) size {2} island {3} | gear DIP {4} | panel DIP ({5},{6}) {7}x{8}" -f `
  $ballCx, $ballCy, $size, $island, $gearCx, $panelLeft, $panelTop, $panelW, $panelHShown)

switch ($Action) {
  'away'  { Write-Host 'parked away' }
  'hover' { [PetInput]::Move((PhysX $ballCx), (PhysY $ballCy)); Write-Host 'on ball' }
  'click' {
    [PetInput]::Move((PhysX $ballCx), (PhysY $ballCy)); Start-Sleep -Milliseconds 700
    [PetInput]::Click(); Write-Host 'clicked ball'
  }
  'gear'      { OpenPanel; Write-Host 'opened panel via gear' }
  'size-low'  { OpenPanel; DragSize ($panelLeft + 16) }
  'size-high' { OpenPanel; DragSize ($panelLeft + $panelW - 16) }
}
