<#
Screenshots of the Windows desktop app with the demo hub (scripts/demo-hub.ts):
the connection page on a first start, Home after pairing with a
conclave://pair link, and a session. Light, then dark.

  pwsh scripts/screenshots/windows.ps1 -App packages/desktop/src-tauri/target/debug/conclave-desktop.exe -Out shots

.github/workflows/screenshots.yml runs it. It starts the demo hub itself
(a process started in one workflow step may not outlive it on Windows) and
stops it at the end. It pairs the way Windows does when someone opens a
pairing link: the link is the app's only argument. "Let the hub use this
computer" is off in the saved settings, so no daemon is installed. Shots
are taken with CopyFromScreen of the window's frame; the window is moved to
the top left corner and kept on top first.
#>
param(
  [Parameter(Mandatory = $true)] [string]$App,
  [string]$Out = 'docs/screenshots/apps/windows',
  [int]$Port = 7810
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
}
'@

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$App = (Resolve-Path $App).Path
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$info = Join-Path $env:TEMP "conclave-demo-$PID.json"
$config = Join-Path $env:APPDATA 'dev.conclave.desktop'
$appName = [System.IO.Path]::GetFileNameWithoutExtension($App)

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Host "screen $($screen.Width)x$($screen.Height)"
if ($screen.Width -lt 1280 -or $screen.Height -lt 900) {
  # the window is 1180x800 inside its frame; a bigger desktop shows all of it
  try {
    Set-DisplayResolution -Width 1920 -Height 1080 -Force -ErrorAction Stop
    Start-Sleep -Seconds 2
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    Write-Host "screen now $($screen.Width)x$($screen.Height)"
  } catch {
    Write-Host "cannot change the resolution ($($_.Exception.Message)); shots show what fits"
  }
}

function Stop-App {
  Get-Process -Name $appName -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}

function Start-App([string[]]$AppArgs) {
  Stop-App
  if ($AppArgs) { $p = Start-Process -FilePath $App -ArgumentList $AppArgs -PassThru } else { $p = Start-Process -FilePath $App -PassThru }
  # the main window of this process (a debug build also opens a console, which belongs to conhost)
  for ($i = 0; $i -lt 60; $i++) {
    $p.Refresh()
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($p.MainWindowHandle -eq [IntPtr]::Zero) { throw 'the app opened no window' }
  $h = $p.MainWindowHandle
  [Win]::ShowWindow($h, 9) | Out-Null
  $r = New-Object Win+RECT
  [Win]::GetWindowRect($h, [ref]$r) | Out-Null
  if (($r.Right - $r.Left) -le $screen.Width -and ($r.Bottom - $r.Top) -le $screen.Height) {
    # top left, on top of everything (HWND_TOPMOST, SWP_NOSIZE | SWP_SHOWWINDOW)
    [Win]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0041) | Out-Null
  } else {
    # a small desktop: the window takes all of it (the page lays itself out for that width)
    [Win]::SetWindowPos($h, [IntPtr](-1), 0, 0, $screen.Width, $screen.Height, 0x0040) | Out-Null
  }
  [Win]::SetForegroundWindow($h) | Out-Null
  return $h
}

function Save-Shot([IntPtr]$h, [string]$name) {
  $r = New-Object Win+RECT
  # the visible frame, without the invisible resize border GetWindowRect counts (DWMWA_EXTENDED_FRAME_BOUNDS)
  if ([Win]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [Win]::GetWindowRect($h, [ref]$r) | Out-Null }
  $left = [Math]::Max($r.Left, 0); $top = [Math]::Max($r.Top, 0)
  $w = [Math]::Min($r.Right, $screen.Width) - $left; $hgt = [Math]::Min($r.Bottom, $screen.Height) - $top
  $bmp = New-Object System.Drawing.Bitmap $w, $hgt
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($left, $top, 0, 0, $bmp.Size)
  $file = Join-Path $Out $name
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host $file
}

# a click at x,y inside the window's client area (the web page)
function Click([IntPtr]$h, [int]$x, [int]$y) {
  $pt = New-Object Win+POINT
  $pt.X = $x; $pt.Y = $y
  [Win]::ClientToScreen($h, [ref]$pt) | Out-Null
  [Win]::SetCursorPos($pt.X, $pt.Y) | Out-Null
  Start-Sleep -Milliseconds 150
  [Win]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
  [Win]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
}

function Pair-Link($demo) {
  $headers = @{ authorization = "Bearer $($demo.token)" }
  $p = Invoke-RestMethod -Method Post -Uri "$($demo.url)/api/pairing" -Headers $headers -ContentType 'application/json' -Body '{"kind":"client"}'
  return "conclave://pair?url=$([Uri]::EscapeDataString($demo.url))&code=$([Uri]::EscapeDataString($p.code))&fp=$($p.fingerprint)"
}

function Set-Theme([string]$theme) {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -Path $key -Name AppsUseLightTheme -Value ([int]($theme -eq 'light')) -Type DWord
  Set-ItemProperty -Path $key -Name SystemUsesLightTheme -Value ([int]($theme -eq 'light')) -Type DWord
}

# the demo hub, for this script only
$hubLog = Join-Path $env:TEMP "conclave-demo-$PID.log"
$bun = (Get-Command bun).Source
$hub = Start-Process -FilePath $bun -ArgumentList @('scripts/demo-hub.ts', '--port', "$Port", '--info', "`"$info`"") -WorkingDirectory $root -RedirectStandardOutput $hubLog -RedirectStandardError "$hubLog.err" -PassThru -NoNewWindow
try {
  # seeding waits up to 90 s a step on a slow runner; a hub that exits stops the wait
  for ($i = 0; $i -lt 300 -and -not (Test-Path $info) -and -not $hub.HasExited; $i++) { Start-Sleep -Seconds 1 }
  Get-Content $hubLog -ErrorAction SilentlyContinue
  if (-not (Test-Path $info)) { Get-Content "$hubLog.err" -ErrorAction SilentlyContinue; throw 'the demo hub did not start' }
  $demo = Get-Content $info -Raw | ConvertFrom-Json

  foreach ($theme in 'light', 'dark') {
    Set-Theme $theme

    # first start: the connection page
    Remove-Item -Recurse -Force $config -ErrorAction SilentlyContinue
    $h = Start-App @()
    Start-Sleep -Seconds 12
    Save-Shot $h "connect-$theme.png"

    # opened from a pairing link: it pairs and loads the hub
    Stop-App
    Remove-Item -Recurse -Force $config -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $config | Out-Null
    Set-Content -Path (Join-Path $config 'settings.json') -Value '{ "computer": false }' -Encoding ascii
    $h = Start-App @(Pair-Link $demo)
    Start-Sleep -Seconds 15
    if (-not (Select-String -Path (Join-Path $config 'settings.json') -Pattern '"token"' -Quiet)) {
      Save-Shot $h "not-paired-$theme.png"
      throw 'the app did not pair'
    }
    Save-Shot $h "home-$theme.png"

    # Sessions in the top bar, then "Fix login redirect" in the list (places that fit the web app at 1180 wide)
    try {
      Click $h 305 24
      Start-Sleep -Seconds 3
      Click $h 134 360
      Start-Sleep -Seconds 3
      Save-Shot $h "session-$theme.png"
    } catch {
      Write-Host "no session shot: $($_.Exception.Message)"
    }
    Stop-App
  }
} finally {
  Stop-App
  Set-Theme 'light'
  # the hub runs as a child of the bun that started it; /T takes the tree
  if ($hub -and -not $hub.HasExited) { & taskkill /PID $hub.Id /T /F | Out-Null }
  Write-Host '--- demo hub log'
  Get-Content $hubLog -ErrorAction SilentlyContinue
  Get-Content "$hubLog.err" -ErrorAction SilentlyContinue
}
