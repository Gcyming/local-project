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
import { existsSync } from "node:fs";
import { join } from "node:path";
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

  // ── A-1044：系统级「用户是否正在操作」探测（让位仲裁的唯一数据源）──
  // 为什么用 GetLastInputInfo 而不是自己 hook 键鼠：它是 Win32 提供的**系统级**最后输入时刻，
  // 覆盖键盘/鼠标/触摸，且**不需要**任何钩子权限（不需要管理员、不注入别的进程）。
  // 为什么这能解决用户报的「点击被吞」：本后端注入输入用的是 SetCursorPos + mouse_event，
  // 与用户共用**同一个物理指针**；只要知道用户手还在键鼠上，就主动停手让路，
  // 而不是硬点上去跟用户抢指针（Windows 没有"不抢焦点地把输入送进别人窗口"的合法通道）。
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();
  /** 探测失败/无效时的哨兵值（0xFFFFFFFF 本身就是"已空闲 49.7 天"，绝不可能是真的） */
  public const uint IDLE_UNAVAILABLE = 0xFFFFFFFFu;
  public static uint IdleMs() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref li)) { return IDLE_UNAVAILABLE; }
    if (li.dwTime == 0) { return IDLE_UNAVAILABLE; }   // 从未收到过输入（无人登录/会话隔离）→ 不可用
    // GetTickCount 与 dwTime 都是 32 位毫秒计数，uint 减法在回绕（49.7 天）时仍得到正确差值
    return GetTickCount() - li.dwTime;
  }
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

# A-1014：指针定位的**唯一入口**（所有鼠标动作都从这里走）。
# 为什么必须收口：原先 9 处全是 SetCursorPos(...) | Out-Null —— 返回值被吞。
# SetCursorPos 会失败（坐标越出虚拟桌面、UAC 安全桌面在前台、输入被其它进程独占），
# 失败后随后的 mouse_event 会把点击打在**指针停留的原处**，而回传给模型的 detail 仍写着
# "已点击 (x,y)" → 模型以为点中了（用户反馈"用的时候总是糊涂"就是这个味道：动作静默打偏）。
# 宁可抛错让 TS 侧回传 ok=false，也不要静默点错位置。
function Move-SlimeCursor([int]$x, [int]$y) {
  if (-not [SlimeInput]::SetCursorPos($x, $y)) {
    throw "无法把指针移到 ($x, $y)：SetCursorPos 被系统拒绝（坐标可能超出虚拟桌面、UAC 安全桌面正在前台、或输入被其它进程独占）"
  }
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
    # A-1034：用 @( ... ) 强制数组。PowerShell 会把**单元素**数组自动展开成标量，
    # ConvertTo-Json 于是产出对象而非数组 —— 恰好只有一个可见窗口时，上层 Array.isArray 判定为假，
    # 枚举结果静默变成空列表，用户看到的是「未枚举到可见窗口」。
    'windows' { return @{ windows = @(Get-SlimeWindows) } }
    'focus' {
      $needle = ''; if ($null -ne $req.title) { $needle = [string]$req.title }
      if (-not $needle) { throw 'focus 需要 title' }
      $hit = Find-SlimeWindow $needle
      if ($null -eq $hit) { return @{ detail = "未找到标题包含「$needle」的窗口"; focused = $false } }
      [SlimeInput]::ShowWindow($hit.MainWindowHandle, 9) | Out-Null   # SW_RESTORE（最小化也拉回来）
      $asked = [SlimeInput]::SetForegroundWindow($hit.MainWindowHandle)
      Start-Sleep -Milliseconds 250
      $r = New-Object SLIME_RECT
      [SlimeInput]::RectOf($hit.MainWindowHandle, [ref]$r) | Out-Null
      $rect = @{ title = $hit.MainWindowTitle; x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
      # A-1014：**回读真实前台窗口**，不再无条件宣布成功。
      # 原因：SetForegroundWindow 在 Windows 上经常被拒（后台进程不得抢前台、前台锁定、
      # 用户正在别的窗口操作…），返回值此前被丢弃、函数无条件返回 focused=$true
      # → captureWindow / screen_focus 全部据此认为"已聚焦"，接着截到/点到压在上面的
      # **另一个窗口**，全程零提示。这是"点错窗口 / 用起来总是糊涂"的直接来源。
      $fg = [SlimeInput]::GetForegroundWindow()
      if ($fg -eq $hit.MainWindowHandle) {
        return @{ focused = $true; detail = "已聚焦窗口「$($hit.MainWindowTitle)」" } + $rect
      }
      $nowTitle = ''
      try {
        $p = Get-Process | Where-Object { $_.MainWindowHandle -eq $fg } | Select-Object -First 1
        if ($null -ne $p) { $nowTitle = [string]$p.MainWindowTitle }
      } catch {}
      if (-not $nowTitle) { $nowTitle = '未知窗口' }
      # 位置照常回传（上层仍可据此区域截图/坐标换算），但**如实说明没抢到前台**。
      return @{ focused = $false; detail = "未能把窗口「$($hit.MainWindowTitle)」带到前台（SetForegroundWindow 返回 $asked，当前前台是「$nowTitle」）——画面可能被其它窗口遮挡；请先手动点一下该窗口，或换用无需焦点的操作方式" } + $rect
    }
    'move' {
      Move-SlimeCursor $x $y
      return @{ detail = "已移动指针到 ($x, $y)" }
    }
    'click' {
      Move-SlimeCursor $x $y
      Start-Sleep -Milliseconds 30
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      return @{ detail = "已在 ($x, $y) 左键单击" }
    }
    'right_click' {
      Move-SlimeCursor $x $y
      Start-Sleep -Milliseconds 30
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
      return @{ detail = "已在 ($x, $y) 右键单击" }
    }
    'middle_click' {
      Move-SlimeCursor $x $y
      Start-Sleep -Milliseconds 30
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_MIDDLEUP, 0, 0, 0, [UIntPtr]::Zero)
      return @{ detail = "已在 ($x, $y) 中键单击" }
    }
    'double_click' {
      Move-SlimeCursor $x $y
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
      Move-SlimeCursor $x $y
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
      Move-SlimeCursor $x $y
      Start-Sleep -Milliseconds 40
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      $steps = 12
      for ($i = 1; $i -le $steps; $i++) {
        $ix = [int]($x + ($tx - $x) * $i / $steps)
        $iy = [int]($y + ($ty - $y) * $i / $steps)
        Move-SlimeCursor $ix $iy
        Start-Sleep -Milliseconds 12
      }
      [SlimeInput]::mouse_event([SlimeInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      return @{ detail = "已从 ($x, $y) 拖拽到 ($tx, $ty)" }
    }
    'scroll' {
      $d = -100; if ($null -ne $req.delta) { $d = [int]$req.delta }
      Move-SlimeCursor $x $y
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
    # A-1044：系统空闲时间探针（**内部动作**，不在 DESKTOP_ACTIONS 里，模型调不到）。
    # 返回值：@{ idleMs = <uint32> } 或 @{ unavailable = $true }（探测不可用 → 上层按"不阻塞但留痕"处理）
    'user_idle' {
      $idle = [SlimeInput]::IdleMs()
      if ($idle -eq [SlimeInput]::IDLE_UNAVAILABLE) { return @{ unavailable = $true } }
      return @{ idleMs = [uint32]$idle }
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

/**
 * A-1034：解析 PowerShell 宿主的**绝对路径**。
 *
 * 为什么不能直接拿裸名去 spawn（`powershell.exe` 这个写法本身）：**"系统自带" ≠ "在 PATH 里"**。
 * Windows 自带的是 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，
 * 但打包后的进程 PATH 未必含 System32 —— 用户的另一台机器就是这样：同一个坑先让
 * platform-tools 解压报 `spawn tar ENOENT`，再让这里宿主起不来，窗口枚举恒为空，
 * 对外表现为「挂不上屏幕」。
 *
 * 顺序：System32 的 Windows PowerShell → SysWOW64 → PowerShell 7（pwsh）→ PATH 兜底。
 * 返回试过的路径列表，失败时一并报出来，避免又变成"静默没功能"。
 */
export function resolvePowerShellExe(): { exe: string; tried: string[] } {
  const tried: string[] = [];
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const cands = [
    join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    join(root, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  const pf = process.env.ProgramFiles;
  if (pf) { cands.push(join(pf, "PowerShell", "7", "pwsh.exe")); }
  for (const c of cands) {
    tried.push(c);
    try { if (existsSync(c)) { return { exe: c, tried }; } } catch { /* 无权限访问 → 继续试下一个 */ }
  }
  return { exe: "powershell.exe", tried };
}

export class DesktopScreenBackend implements ScreenBackend {
  readonly id = "desktop" as const;
  readonly actions = DESKTOP_ACTIONS;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private booting: Promise<void> | null = null;
  private pending: Pending[] = [];
  private stdoutBuf = "";
  private stderrBuf = "";
  private cachedSize: { width: number; height: number; originX: number; originY: number } | null = null;

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
      // A-1034：绝对路径优先，PATH 只是最后的兜底（见 resolvePowerShellExe 的注释）
      const host = resolvePowerShellExe();
      const proc = spawn(
        host.exe,
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
        // A-1034：失败必须带上"试过哪些路径"，否则用户只能看到一句 ENOENT 无从下手
        const hint = host.exe === "powershell.exe"
          ? `（已尝试并回退 PATH：${host.tried.join(" | ")}）`
          : `（路径：${host.exe}）`;
        const msg = `启动 PowerShell 失败：${e.message}${hint}`;
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
    // A-1014：**必须**把虚拟桌面原点一起收下（PowerShell 侧 `size` 分支早就返回了
    // `GetSystemMetrics(76/77)`，此前在这里被丢弃 → 整屏坐标基准的 origin 恒为 0 →
    // 副屏在主屏左/上（vx/vy 为负）时点击整体偏移）。取不到时按 0 处理（单屏下正确）。
    const originX = Number(r.result.originX ?? 0) || 0;
    const originY = Number(r.result.originY ?? 0) || 0;
    this.cachedSize = { width, height, originX, originY };
    return { backend: "desktop", target: target || "primary", width, height, originX, originY, label: `主显示器 ${width}×${height}` };
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
      // A-1014：虚拟桌面原点 —— 图像 0 点 = 虚拟坐标 (vx,vy)，必须一并回传，
      // 否则 controller 的坐标基准 origin 为 0，副屏在左/上时点击整体偏移（见 DisplayInfo 注释）。
      let originX = this.cachedSize?.originX ?? 0;
      let originY = this.cachedSize?.originY ?? 0;
      if (!devW || !devH) {
        try {
          const info = await this.displayInfo(target);
          devW = info.width; devH = info.height;
          originX = info.originX ?? 0; originY = info.originY ?? 0;
        } catch { /* 尺寸取不到不阻断截图 */ }
      }
      const bytes = Math.floor((pngBase64.length * 3) / 4);
      // 桌面只叠网格刻度（不做元素框：桌面无 uiautomator，元素树不可得）
      const opt = toOptimizedDataUrl(pngBase64, { grid: opts?.marks !== false });
      const imageW = opt.width; const imageH = opt.height;
      return {
        ok: true, pngBase64, dataUrl: opt.dataUrl,
        width: devW, height: devH,
        originX, originY,
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
    // A-1034：**不再把"形状不对"静默当成"没有窗口"**。
    // 旧写法 `Array.isArray(...) ? … : []` 会把单元素折叠（PowerShell 标量化）、
    // 字段改名、宿主降级返回等一切异常都伪装成"未枚举到可见窗口" —— 用户看到的是
    // "这功能没有"，而不是"枚举失败了"，这是本项目最贵的一类失效（静默降级）。
    // 现在：数组直接用；对象视为单窗口（容错）；其余一律抛错，让上层如实报给模型。
    const raw = r.result.windows;
    let list: Array<Record<string, unknown>>;
    if (Array.isArray(raw)) {
      list = raw as Array<Record<string, unknown>>;
    } else if (raw === null || raw === undefined) {
      list = [];
    } else if (typeof raw === "object") {
      list = [raw as Record<string, unknown>];
    } else {
      throw new Error(`枚举窗口失败：宿主返回的 windows 字段形状异常（${typeof raw}）`);
    }
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
    // A-1014：**无论是否抢到前台都回传矩形**（宿主两个分支都带 rect）。
    // 上层据此仍能区域截图与坐标换算；是否"可安全操作"由上层结合 focused 决定，
    // 不再把"没抢到前台"一律当成"窗口不可用"（窗口其实可见时那是可用路径）。
    const rect = {
      x: Number(r.result.x ?? 0), y: Number(r.result.y ?? 0),
      width: Number(r.result.width ?? 0), height: Number(r.result.height ?? 0),
    };
    const hasRect = rect.width > 0 && rect.height > 0;
    return { focused, detail: String(r.result.detail ?? ""), rect: hasRect ? rect : undefined };
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
    if (!f.rect) { return { ok: false, error: f.detail || `未找到标题包含「${t}」的窗口` }; }
    const rect = f.rect;
    if (rect.width <= 0 || rect.height <= 0) { return { ok: false, error: "窗口尺寸为 0（可能已最小化）" }; }
    // A-1014：最小化窗口在 Windows 上被放在 (-32000, -32000) 附近。此时 SW_RESTORE 也没能
    // 救回来（否则矩形会正常）→ 截这个区域只会得到屏幕外的空白，点击也会打到屏外。
    // 这是**真不可用**，必须硬失败并说清原因（不要截一张空白图让模型瞎猜）。
    if (rect.x <= -30000 || rect.y <= -30000) {
      return { ok: false, error: `窗口「${t}」仍处于最小化状态（矩形 ${rect.x},${rect.y}）——请先手动还原该窗口，或改用不依赖窗口截图的方式` };
    }
    // A-1014：**没能抢到前台不再等于不能截**。窗口若是可见的（只是没获得焦点），
    // 区域截图依然正确；只有当它被别的窗口盖住时画面才不是目标窗口 ——
    // 那种情况交一张带 warning 的图给模型，让它自己看图判断，比硬失败更有用。
    const focusWarning = f.focused
      ? undefined
      : `${f.detail}；本图只保证是屏幕该区域的画面，若被其它窗口遮挡请先手动把「${t}」切到前台`;
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
      warning: focusWarning,
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

  /** A-1044：系统级空闲时间（距上次用户键鼠输入）。`null` = 探测不可用（不等于"用户没操作"）。
   *  让位仲裁（`arbiter.ts`）唯一的数据源；非 Windows 平台如实返回 null。 */
  async userIdleMs(): Promise<number | null> {
    if (this.unsupportedReason()) { return null; }
    try {
      const r = await this.send({ kind: "user_idle" });
      if (!r.ok || !r.result) { return null; }
      if (r.result.unavailable === true) { return null; }
      const v = r.result.idleMs;
      if (typeof v !== "number" || !Number.isFinite(v)) { return null; }
      return v;
    } catch {
      // 宿主未就绪/超时：探测不可用。**不抛**——让位判据的语义是"探测不到就放行但留痕"，
      // 而不是让一次探针失败把用户的图形操作整条打断。
      return null;
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
