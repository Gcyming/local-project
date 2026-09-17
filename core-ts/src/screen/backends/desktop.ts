/**
 * core-ts/src/screen/backends/desktop.ts — 桌面图形控制后端（Windows 优先）。
 *
 * 实现选择（调研结论：computer-use-mcp / Claude Code hostAdapter）：
 *   Windows 自带 PowerShell + .NET Framework，经 user32.dll（SetCursorPos / mouse_event /
 *   keybd_event / SendInput）+ System.Drawing 即可完成截屏与输入注入 —— **零外部依赖**。
 *   唯一缺点是每次冷启 PowerShell + Add-Type 需 200-500ms，因此这里采用
 *   **常驻 PowerShell 宿主**：Add-Type 只编译一次，之后走换行分隔的 base64(JSON) 请求-响应协议，
 *   单次动作开销降到毫秒级。
 *
 * 协议（stdin/stdout 各一行一条）：
 *   请求： base64(UTF-8 JSON) + "\n"
 *   响应： "@@R@@" + base64(UTF-8 JSON) + "\n"
 *
 * 安全：脚本以 -EncodedCommand 传入（不落盘、无引号注入面）；所有输入走 JSON 参数，
 * 不拼接 shell 命令。DPI 感知在宿主启动时调用 SetProcessDPIAware 一次性解决。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  DisplayInfo,
  ScreenAction,
  ScreenActionKind,
  ScreenActionResult,
  ScreenBackend,
  ScreenCaptureResult,
} from "../types.js";
import { toOptimizedDataUrl } from "../optimize.js";

/** 桌面后端支持的动作（Android 专属的 tap/swipe 不在其中，由 android 后端承载） */
const DESKTOP_ACTIONS: ReadonlySet<ScreenActionKind> = new Set<ScreenActionKind>([
  "click", "double_click", "right_click", "middle_click", "mouse_move",
  "drag", "scroll", "type", "key", "wait", "long_press",
]);

const RESP_PREFIX = "@@R@@";
const CALL_TIMEOUT_MS = 20_000;
const BOOT_TIMEOUT_MS = 25_000;

/** 常驻 PowerShell 宿主脚本（UTF-16LE base64 经 -EncodedCommand 传入） */
const PS_HOST = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::InputEncoding  = [System.Text.Encoding]::UTF8 } catch {}
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SlimeInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int size);

  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint msg; public ushort paramL; public ushort paramH; }
  [StructLayout(LayoutKind.Explicit)]  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }

  public const uint MOUSEEVENTF_LEFTDOWN   = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP     = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN  = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP    = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP   = 0x0040;
  public const uint MOUSEEVENTF_WHEEL      = 0x0800;
  public const uint KEYEVENTF_KEYUP   = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;
  public const uint INPUT_KEYBOARD    = 1;

  public static void SendChar(char c) {
    INPUT[] a = new INPUT[2];
    a[0].type = INPUT_KEYBOARD; a[0].U.ki.vk = 0; a[0].U.ki.scan = (ushort)c; a[0].U.ki.flags = KEYEVENTF_UNICODE;
    a[1].type = INPUT_KEYBOARD; a[1].U.ki.vk = 0; a[1].U.ki.scan = (ushort)c; a[1].U.ki.flags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void SendVk(ushort vk, bool up) {
    keybd_event((byte)vk, 0, up ? KEYEVENTF_KEYUP : 0, UIntPtr.Zero);
  }

  // ── A-977：DPI 感知（per-monitor v2，失败回退 system aware）──
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  public static void InitDpi() {
    try { SetProcessDpiAwarenessContext((IntPtr)(-4)); return; } catch {}
    try { SetProcessDPIAware(); } catch {}
  }

  // ── A-977：前台/窗口枚举与聚焦（先把目标窗口带到前台再点，避免点错窗口）──
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out SLIME_RECT r);
  public static bool RectOf(IntPtr h, out SLIME_RECT r) { return GetWindowRect(h, out r); }
}

[StructLayout(LayoutKind.Sequential)]
public struct SLIME_RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@

function Get-SlimeShot($rx, $ry, $rw, $rh) {
  # A-977：默认截「整个虚拟桌面」（覆盖全部显示器）——此前只截主屏，多显示器下坐标必然错。
  # A-978：传入 rx/ry/rw/rh 时只截该矩形（按窗口截图用），坐标仍为虚拟桌面绝对坐标。
  # 虚拟桌面原点 (SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN) 可能为负（副屏在主屏左侧/上方），
  # SetCursorPos 用的也是虚拟桌面坐标，故图像坐标 == 虚拟坐标，二者天然一致。
  if ($null -ne $rw -and $null -ne $rh -and [int]$rw -gt 0 -and [int]$rh -gt 0) {
    $vx = [int]$rx; $vy = [int]$ry; $vw = [int]$rw; $vh = [int]$rh
  } else {
    $vx = [SlimeInput]::GetSystemMetrics(76)
    $vy = [SlimeInput]::GetSystemMetrics(77)
    $vw = [SlimeInput]::GetSystemMetrics(78)
    $vh = [SlimeInput]::GetSystemMetrics(79)
    if ($vw -le 0 -or $vh -le 0) {
      $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $vx = $b.X; $vy = $b.Y; $vw = $b.Width; $vh = $b.Height
    }
  }
  $bmp = New-Object System.Drawing.Bitmap $vw, $vh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vx, $vy, 0, 0, $bmp.Size)
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  $s = [Convert]::ToBase64String($ms.ToArray())
  $ms.Dispose()
  return $s
}

# A-978：按标题找窗口（返回 $null 或进程对象）；多个匹配取第一个
function Find-SlimeWindow([string]$needle) {
  if (-not $needle) { return $null }
  foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle })) {
    if ($p.MainWindowTitle.ToLower().Contains($needle.ToLower())) { return $p }
  }
  return $null
}

# A-977：枚举有窗口的可见进程（标题 + 矩形），供"先聚焦目标窗口再操作"
function Get-SlimeWindows {
  $out = @()
  foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle })) {
    $r = New-Object SLIME_RECT
    $ok = [SlimeInput]::RectOf($p.MainWindowHandle, [ref]$r)
    if (-not $ok) { continue }
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    if ($w -le 0 -or $h -le 0) { continue }
    $out += @{ title = $p.MainWindowTitle; pid = $p.Id; x = $r.Left; y = $r.Top; width = $w; height = $h }
  }
  return $out
}

# 按键名 → 虚拟键码
$VK = @{
  'enter'=13;'return'=13;'esc'=27;'escape'=27;'tab'=9;'space'=32;'backspace'=8;'delete'=46;
  'del'=46;'insert'=45;'home'=36;'end'=35;'pageup'=33;'pagedown'=34;
  'up'=38;'down'=40;'left'=37;'right'=39;
  'ctrl'=17;'control'=17;'alt'=18;'shift'=16;'win'=91;'meta'=91;'cmd'=91;
  'f1'=112;'f2'=113;'f3'=114;'f4'=115;'f5'=116;'f6'=117;'f7'=118;'f8'=119;'f9'=120;'f10'=121;'f11'=122;'f12'=123;
  'capslock'=20;'numlock'=144;'printscreen'=44;'scrolllock'=145;'pause'=19;
}
for ($i = 0; $i -lt 26; $i++) { $VK[[string][char](97 + $i)] = 65 + $i }
for ($i = 0; $i -lt 10; $i++) { $VK[[string][char](48 + $i)] = 48 + $i }

function Resolve-Vk([string]$name) {
  $k = ($name ?? '').Trim().ToLower()
  if (-not $k) { throw "按键名为空" }
  if ($k.StartsWith('vk:')) { return [int]$k.Substring(3) }
  if ($VK.ContainsKey($k)) { return $VK[$k] }
  throw "无法识别的按键 '$name'（可用：enter/esc/tab/ctrl+alt+delete 风格组合 / f1-f12 / a-z / 0-9 / vk:<码>）"
}

function Invoke-SlimeAction($req) {
  $k = $req.kind
  $x = 0; if ($null -ne $req.x) { $x = [int]$req.x }
  $y = 0; if ($null -ne $req.y) { $y = [int]$req.y }
  switch ($k) {
    'size' {
      [SlimeInput]::InitDpi()
      # A-977：返回**虚拟桌面**尺寸（覆盖全部显示器）+ 原点；原点可能为负（副屏在主屏左侧/上方）
      $vw = [SlimeInput]::GetSystemMetrics(78); $vh = [SlimeInput]::GetSystemMetrics(79)
      if ($vw -le 0 -or $vh -le 0) { $vw = [SlimeInput]::GetSystemMetrics(0); $vh = [SlimeInput]::GetSystemMetrics(1) }
      return @{ width = $vw; height = $vh; originX = [SlimeInput]::GetSystemMetrics(76); originY = [SlimeInput]::GetSystemMetrics(77) }
    }
    'capture' {
      # A-978：带 rect 时只截该矩形（按窗口截图）
      $rect = $req.rect
      if ($null -ne $rect) { return @{ png = (Get-SlimeShot $rect.x $rect.y $rect.w $rect.h) } }
      return @{ png = (Get-SlimeShot) }
    }
    'windowRect' {
      $needle = ''; if ($null -ne $req.title) { $needle = [string]$req.title }
      $hit = Find-SlimeWindow $needle
      if ($null -eq $hit) { return @{ found = $false; detail = "未找到标题包含「$needle」的窗口" } }
      $r = New-Object SLIME_RECT
      [SlimeInput]::RectOf($hit.MainWindowHandle, [ref]$r) | Out-Null
      return @{ found = $true; title = $hit.MainWindowTitle; x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
    }
    'windows' { return @{ windows = (Get-SlimeWindows) } }
    'focus' {
      $needle = ''; if ($null -ne $req.title) { $needle = [string]$req.title }
      if (-not $needle) { throw 'focus 需要 title' }
      $hit = Find-SlimeWindow $needle
      if ($null -eq $hit) { return @{ detail = "未找到标题包含「$needle」的窗口"; focused = $false } }
      [SlimeInput]::ShowWindow($hit.MainWindowHandle, 9) | Out-Null   # SW_RESTORE（最小化也拉回来）
      [SlimeInput]::SetForegroundWindow($hit.MainWindowHandle) | Out-Null
      Start-Sleep -Milliseconds 250
      $r = New-Object SLIME_RECT
      [SlimeInput]::RectOf($hit.MainWindowHandle, [ref]$r) | Out-Null
      return @{ focused = $true; detail = "已聚焦窗口「$($hit.MainWindowTitle)」"; title = $hit.MainWindowTitle; x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
    }
    'move' {
      [SlimeInput]::SetCursorPos($x, $y) | Out-Null
      return @{ detail = "已移动指针到 ($x, $y)" }
    }
    'click' {
      [SlimeInput]::SetCursorPos($x, $y) | Out-Null
      Start-Sleep -Milliseconds 30
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      return @{ detail = "已在 ($x, $y) 左键单击" }
    }
    'right_click' {
      [SlimeInput]::SetCursorPos($x, $y) | Out-Null
      Start-Sleep -Milliseconds 30
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
      return @{ detail = "已在 ($x, $y) 右键单击" }
    }
    'middle_click' {
      [SlimeInput]::SetCursorPos($x, $y) | Out-Null
      Start-Sleep -Milliseconds 30
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_MIDDLEUP, 0, 0, 0, [UIntPtr]::Zero)
      return @{ detail = "已在 ($x, $y) 中键单击" }
    }
    'double_click' {
      [SlimeInput]::SetCursorPos($x, $y) | Out-Null
      Start-Sleep -Milliseconds 30
      for ($i = 0; $i -lt 2; $i++) {
        [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 15
        [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
        if ($i -eq 0) { Start-Sleep -Milliseconds 60 }
      }
      return @{ detail = "已在 ($x, $y) 双击" }
    }
    'long_press' {
      [SlimeInput]::SetCursorPos($x, $y) | Out-Null
      Start-Sleep -Milliseconds 30
      $ms = 800; if ($null -ne $req.durationMs) { $ms = [int]$req.durationMs }
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds $ms
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      return @{ detail = "已在 ($x, $y) 按住左键 $ms ms" }
    }
    'drag' {
      $tx = 0; if ($null -ne $req.x2) { $tx = [int]$req.x2 }
      $ty = 0; if ($null -ne $req.y2) { $ty = [int]$req.y2 }
      [SlimeInput]::SetCursorPos($x, $y) | Out-Null
      Start-Sleep -Milliseconds 40
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      $steps = 12
      for ($i = 1; $i -le $steps; $i++) {
        $ix = [int]($x + ($tx - $x) * $i / $steps)
        $iy = [int]($y + ($ty - $y) * $i / $steps)
        [SlimeInput]::SetCursorPos($ix, $iy) | Out-Null
        Start-Sleep -Milliseconds 12
      }
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      return @{ detail = "已从 ($x, $y) 拖拽到 ($tx, $ty)" }
    }
    'scroll' {
      $d = -100; if ($null -ne $req.delta) { $d = [int]$req.delta }
      [SlimeInput]::SetCursorPos($x, $y) | Out-Null
      $notches = [int]([Math]::Round($d / 100.0))
      if ($notches -eq 0) { $notches = if ($d -gt 0) { 1 } else { -1 } }
      for ($i = 0; $i -lt [Math]::Abs($notches); $i++) {
        $amt = if ($notches -gt 0) { 120 } else { -120 }
        [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_WHEEL, 0, 0, $amt, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 20
      }
      return @{ detail = "已在 ($x, $y) 滚动 $notches 格" }
    }
    'type' {
      $t = [string]$req.text
      if ([string]::IsNullOrEmpty($t)) { throw "type 需要 text 参数" }
      foreach ($ch in $t.ToCharArray()) {
        if ($ch -eq [char]10) { [SlimeInput]::SendVk(13, $false); [SlimeInput]::SendVk(13, $true) }
        elseif ($ch -eq [char]9) { [SlimeInput]::SendVk(9, $false); [SlimeInput]::SendVk(9, $true) }
        elseif ($ch -eq [char]13) { }
        else { [SlimeInput]::SendChar($ch) }
        Start-Sleep -Milliseconds 8
      }
      return @{ detail = "已键入 $($t.Length) 个字符" }
    }
    'key' {
      $spec = [string]$req.key
      if ([string]::IsNullOrWhiteSpace($spec)) { throw "key 需要 key 参数" }
      $parts = $spec.Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
      if ($parts.Count -eq 0) { throw "key 参数为空" }
      $codes = @()
      foreach ($p in $parts) { $codes += (Resolve-Vk $p) }
      foreach ($c in $codes) { [SlimeInput]::SendVk([uint16]$c, $false) }
      Start-Sleep -Milliseconds 30
      for ($i = $codes.Count - 1; $i -ge 0; $i--) { [SlimeInput]::SendVk([uint16]$codes[$i], $true) }
      return @{ detail = "已发送按键 $spec" }
    }
    'wait' {
      $ms = 500; if ($null -ne $req.durationMs) { $ms = [int]$req.durationMs }
      if ($ms -gt 30000) { $ms = 30000 }
      Start-Sleep -Milliseconds $ms
      return @{ detail = "已等待 $ms ms" }
    }
    default { throw "桌面后端不支持动作 '$k'" }
  }
}

# 常驻循环：读一行 base64(JSON) → 执行 → 回一行 @@R@@base64(JSON)
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Trim()))
    $req = $json | ConvertFrom-Json
    $res = Invoke-SlimeAction $req
    $payload = @{ ok = $true; result = $res } | ConvertTo-Json -Compress -Depth 6
  } catch {
    $payload = @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 6
  }
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($payload))
  [Console]::Out.WriteLine("@@R@@$b64")
  [Console]::Out.Flush()
}
`;

interface Pending {
  resolve: (v: { ok: boolean; result?: Record<string, unknown>; error?: string }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class DesktopScreenBackend implements ScreenBackend {
  readonly id = "desktop" as const;
  readonly actions = DESKTOP_ACTIONS;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private booting: Promise<void> | null = null;
  private pending: Pending[] = [];
  private stdoutBuf = "";
  private stderrBuf = "";
  private cachedSize: { width: number; height: number } | null = null;

  /** 平台能力：目前完整实现 Windows；其它平台如实报错（不假装支持） */
  private unsupportedReason(): string | null {
    if (process.platform === "win32") { return null; }
    return `桌面图形控制当前仅在 Windows 上实现（当前平台：${process.platform}）。可改用 backend="android" 控制安卓设备。`;
  }

  private async ensureHost(): Promise<void> {
    const unsupported = this.unsupportedReason();
    if (unsupported) { throw new Error(unsupported); }
    if (this.proc && !this.proc.killed) { return; }
    if (this.booting) { return this.booting; }
    this.booting = new Promise<void>((resolve, reject) => {
      const encoded = Buffer.from(PS_HOST, "utf16le").toString("base64");
      const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      this.proc = proc;
      this.stdoutBuf = "";
      this.stderrBuf = "";

      let settled = false;
      const bootTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("PowerShell 图形控制宿主启动超时"));
        }
      }, BOOT_TIMEOUT_MS);

      // 宿主就绪判定：Add-Type 完成后会执行到常驻循环 —— 用一个 size 探针确认
      const probe = () => {
        if (settled) { return; }
        settled = true;
        clearTimeout(bootTimer);
        resolve();
      };

      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        this.stdoutBuf += chunk;
        let idx = this.stdoutBuf.indexOf("\n");
        while (idx >= 0) {
          const line = this.stdoutBuf.slice(0, idx).replace(/\r$/, "");
          this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
          const p = this.pending.shift();
          if (p) {
            clearTimeout(p.timer);
            if (line.startsWith(RESP_PREFIX)) {
              try {
                const json = Buffer.from(line.slice(RESP_PREFIX.length), "base64").toString("utf8");
                p.resolve(JSON.parse(json) as { ok: boolean; result?: Record<string, unknown>; error?: string });
              } catch (e) {
                p.reject(new Error(`宿主响应解析失败：${e instanceof Error ? e.message : String(e)}`));
              }
            } else if (line.trim()) {
              p.reject(new Error(`宿主返回异常行：${line.slice(0, 200)}`));
            }
          } else if (!settled && line.trim()) {
            // 首次输出（Add-Type 警告等）不计入协议帧
            probe();
          }
          idx = this.stdoutBuf.indexOf("\n");
        }
      });

      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (c: string) => { this.stderrBuf += c; });

      proc.on("error", (e: Error) => {
        const msg = `启动 PowerShell 失败：${e.message}`;
        this.failAll(msg);
        if (!settled) { settled = true; clearTimeout(bootTimer); reject(new Error(msg)); }
      });

      proc.on("exit", (code: number | null) => {
        const tail = this.stderrBuf.trim().slice(-400);
        const msg = `PowerShell 宿主已退出（code=${code}）${tail ? `：${tail}` : ""}`;
        this.proc = null;
        this.booting = null;
        this.cachedSize = null;
        this.failAll(msg);
      });

      // 立刻发一个 size 探针，确保脚本已进入常驻循环（Add-Type 编译完成）
      this.rawSend({ kind: "size" })
        .then(() => { probe(); })
        .catch((e: Error) => {
          if (!settled) { settled = true; clearTimeout(bootTimer); reject(e); }
        });
    });
    // 宿主就绪后保留 booting（并发调用复用；宿主退出时在 exit 回调清空）
    await this.booting;
  }

  private failAll(msg: string): void {
    const list = this.pending;
    this.pending = [];
    for (const p of list) {
      clearTimeout(p.timer);
      p.reject(new Error(msg));
    }
  }

  /** 直接写一帧（不做 ensureHost，供启动探针使用） */
  private rawSend(req: Record<string, unknown>): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
    return new Promise((resolve, reject) => {
      const proc = this.proc;
      if (!proc) { reject(new Error("图形控制宿主未启动")); return; }
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.timer === timer);
        if (i >= 0) { this.pending.splice(i, 1); }
        reject(new Error("图形控制动作超时"));
      }, CALL_TIMEOUT_MS);
      this.pending.push({ resolve, reject, timer });
      const b64 = Buffer.from(JSON.stringify(req), "utf8").toString("base64");
      try {
        proc.stdin.write(`${b64}\n`, "utf8");
      } catch (e) {
        clearTimeout(timer);
        reject(new Error(`写入宿主失败：${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  private async send(req: Record<string, unknown>): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
    await this.ensureHost();
    return this.rawSend(req);
  }

  async listTargets(): Promise<DisplayInfo[]> {
    return [await this.displayInfo("primary")];
  }

  async displayInfo(target?: string): Promise<DisplayInfo> {
    if (this.cachedSize) {
      return { backend: "desktop", target: target || "primary", ...this.cachedSize, label: `主显示器 ${this.cachedSize.width}×${this.cachedSize.height}` };
    }
    const r = await this.send({ kind: "size" });
    if (!r.ok || !r.result) {
      throw new Error(r.error ?? "无法读取桌面分辨率");
    }
    const width = Number(r.result.width ?? 0);
    const height = Number(r.result.height ?? 0);
    if (!width || !height) { throw new Error("桌面分辨率解析失败"); }
    this.cachedSize = { width, height };
    return { backend: "desktop", target: target || "primary", width, height, label: `主显示器 ${width}×${height}` };
  }

  async capture(target?: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult> {
    const unsupported = this.unsupportedReason();
    if (unsupported) { return { ok: false, error: unsupported }; }
    try {
      const r = await this.send({ kind: "capture" });
      if (!r.ok || !r.result) { return { ok: false, error: r.error ?? "截图失败" }; }
      const pngBase64 = String(r.result.png ?? "");
      if (!pngBase64) { return { ok: false, error: "截图返回为空" }; }
      // A-975：物理分辨率（坐标落地基准）
      let devW = this.cachedSize?.width ?? 0;
      let devH = this.cachedSize?.height ?? 0;
      if (!devW || !devH) {
        try {
          const info = await this.displayInfo(target);
          devW = info.width; devH = info.height;
        } catch { /* 尺寸取不到不阻断截图 */ }
      }
      const bytes = Math.floor((pngBase64.length * 3) / 4);
      // 桌面只叠网格刻度（不做元素框：桌面无 uiautomator，元素树不可得）
      const opt = toOptimizedDataUrl(pngBase64, { grid: opts?.marks !== false });
      const imageW = opt.width; const imageH = opt.height;
      return {
        ok: true, pngBase64, dataUrl: opt.dataUrl,
        width: devW, height: devH,
        imageWidth: imageW, imageHeight: imageH,
        bytes: opt.bytes || bytes,
        annotate: opts?.marks !== false
          ? { grid: true, marks: 0, scaleX: imageW && devW ? Number((devW / imageW).toFixed(4)) : 1, scaleY: imageH && devH ? Number((devH / imageH).toFixed(4)) : 1 }
          : undefined,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** A-977：枚举可见窗口（标题 + 矩形）——供"先聚焦目标窗口再操作" */
  async listWindows(): Promise<Array<{ title: string; pid: number; x: number; y: number; width: number; height: number }>> {
    const unsupported = this.unsupportedReason();
    if (unsupported) { throw new Error(unsupported); }
    const r = await this.send({ kind: "windows" });
    if (!r.ok || !r.result) { throw new Error(r.error ?? "枚举窗口失败"); }
    const list = Array.isArray(r.result.windows) ? (r.result.windows as Array<Record<string, unknown>>) : [];
    return list.map((w) => ({
      title: String(w.title ?? ""),
      pid: Number(w.pid ?? 0),
      x: Number(w.x ?? 0),
      y: Number(w.y ?? 0),
      width: Number(w.width ?? 0),
      height: Number(w.height ?? 0),
    }));
  }

  /** A-977：按标题（包含匹配）聚焦/还原窗口，返回其矩形 */
  async focusWindow(title: string): Promise<{ focused: boolean; detail: string; rect?: { x: number; y: number; width: number; height: number } }> {
    const unsupported = this.unsupportedReason();
    if (unsupported) { throw new Error(unsupported); }
    const r = await this.send({ kind: "focus", title });
    if (!r.ok || !r.result) { throw new Error(r.error ?? "聚焦窗口失败"); }
    const focused = Boolean(r.result.focused);
    return {
      focused,
      detail: String(r.result.detail ?? ""),
      rect: focused
        ? { x: Number(r.result.x ?? 0), y: Number(r.result.y ?? 0), width: Number(r.result.width ?? 0), height: Number(r.result.height ?? 0) }
        : undefined,
    };
  }

  /**
   * A-978：按窗口标题截取**该窗口区域**（先聚焦 → 取矩形 → 区域截取）。
   * 返回的 width/height = 窗口尺寸、originX/originY = 窗口左上角，
   * controller 的坐标换算会带上这个原点 → 截图后按图内坐标点击不会整体偏移。
   */
  async captureWindow(title: string, opts?: { marks?: boolean }): Promise<ScreenCaptureResult> {
    const unsupported = this.unsupportedReason();
    if (unsupported) { return { ok: false, error: unsupported }; }
    const t = (title ?? "").trim();
    if (!t) { return { ok: false, error: "需要窗口标题（片段即可）" }; }
    // ① 先聚焦：顺带把最小化/被遮挡的窗口拉到前台，否则会截到压在上面的别的窗口
    const f = await this.focusWindow(t);
    if (!f.focused || !f.rect) { return { ok: false, error: f.detail || `未找到标题包含「${t}」的窗口` }; }
    const rect = f.rect;
    if (rect.width <= 0 || rect.height <= 0) { return { ok: false, error: "窗口尺寸为 0（可能已最小化）" }; }
    // ② 区域截取
    const r = await this.send({ kind: "capture", rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } });
    if (!r.ok || !r.result) { return { ok: false, error: r.error ?? "窗口截图失败" }; }
    const png = String(r.result.png ?? "");
    if (!png) { return { ok: false, error: "窗口截图返回为空" }; }
    const bytes = Math.floor((png.length * 3) / 4);
    const opt = toOptimizedDataUrl(png, { grid: opts?.marks !== false });
    return {
      ok: true,
      pngBase64: png,
      dataUrl: opt.dataUrl,
      width: rect.width, height: rect.height,      // 区域（窗口）尺寸
      originX: rect.x, originY: rect.y,            // ★ 区域原点
      imageWidth: opt.width, imageHeight: opt.height,
      bytes: opt.bytes || bytes,
      annotate: opts?.marks !== false
        ? {
            grid: true, marks: 0,
            scaleX: opt.width ? Number((rect.width / opt.width).toFixed(4)) : 1,
            scaleY: opt.height ? Number((rect.height / opt.height).toFixed(4)) : 1,
          }
        : undefined,
    };
  }

  async perform(action: ScreenAction, _target?: string, _info?: DisplayInfo): Promise<ScreenActionResult> {
    const unsupported = this.unsupportedReason();
    if (unsupported) { return { ok: false, error: unsupported }; }
    try {
      const r = await this.send({
        kind: action.kind,
        x: action.x,
        y: action.y,
        x2: action.x2,
        y2: action.y2,
        text: action.text,
        key: action.key,
        delta: action.delta,
        durationMs: action.durationMs,
      });
      if (!r.ok) { return { ok: false, error: (r.error ?? "动作执行失败").slice(0, 400) }; }
      return { ok: true, detail: String(r.result?.detail ?? "已执行") };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 应用退出时释放宿主进程 */
  dispose(): void {
    const proc = this.proc;
    this.proc = null;
    this.booting = null;
    this.cachedSize = null;
    if (proc && !proc.killed) {
      try { proc.stdin.end(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
    }
  }
}
