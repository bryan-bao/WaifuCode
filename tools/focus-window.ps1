# 按标题找一个窗口，然后把它捞到最前面 —— 或者反过来，把它藏起来。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File focus-window.ps1 -Title "WaifuCode · 项目名"
#   powershell -NoProfile -ExecutionPolicy Bypass -File focus-window.ps1 -ProcessId 12345
#   powershell -NoProfile -ExecutionPolicy Bypass -File focus-window.ps1 -Title "…" -Minimize -WaitMs 8000
#
# 为什么不能只调 SetForegroundWindow：
#   Windows 有前台锁，一个没在跟用户交互的进程去抢前台会被系统**静默拒绝**
#   —— 函数返回 false，窗口只在任务栏闪一下。绕法是先把自己的线程输入队列
#   挂到当前前台窗口的线程上（AttachThreadInput），借它的资格去设置，设完再摘掉。
#   窗口最小化时还得先 SW_RESTORE，否则前台化了也只是个图标。
#
# -Minimize 是给「后台派活」用的：Windows Terminal **没有**「最小化启动」这个开关
#   （只有 -M/--maximized、-F/--fullscreen、-f/--focus、--pos、--size），
#   所以只能开出来之后再收，露脸那一下躲不掉（实测约 250 毫秒）。
#   窗口是异步创建的（wt.exe 只是转发器），所以要轮询等它出现。

param(
  [string]$Title = '',
  [int]$ProcessId = 0,
  [switch]$Minimize,
  [string]$SendKeys = '',
  [switch]$PasteStdin,
  [string]$PasteB64 = '',
  [switch]$Exact,
  [int]$WaitMs = 0
)

$ErrorActionPreference = 'Stop'
$script:Exact = $Exact
$script:PasteStdin = $PasteStdin
$script:PasteB64 = $PasteB64

# 超过这个坐标就当窗口跑到你看不见的地方去了，调回前台时顺手挪回来。
# 不挪的话你点了「看看她在干嘛」，窗口是"恢复"了，但恢复到了你看不见的位置。
$OFFSCREEN_MARK = 20000

Add-Type -Namespace Waifu -Name Win -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

[DllImport("user32.dll")]
public static extern int GetWindowTextLength(IntPtr hWnd);

[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr hWnd);

[DllImport("user32.dll")]
public static extern bool IsIconic(IntPtr hWnd);

[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

[DllImport("user32.dll")]
public static extern bool SetForegroundWindow(IntPtr hWnd);

[DllImport("user32.dll")]
public static extern bool BringWindowToTop(IntPtr hWnd);

[DllImport("user32.dll")]
public static extern IntPtr GetForegroundWindow();

[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

[DllImport("user32.dll")]
public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

[DllImport("user32.dll")]
public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

[DllImport("user32.dll")]
public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

[DllImport("kernel32.dll")]
public static extern uint GetCurrentThreadId();

public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

function Get-WindowTitle([IntPtr]$h) {
  $len = [Waifu.Win]::GetWindowTextLength($h)
  if ($len -le 0) { return '' }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][Waifu.Win]::GetWindowText($h, $sb, $sb.Capacity)
  return $sb.ToString()
}

# 找一次。找不到返回 IntPtr::Zero
#
# 【为什么不能只用 Contains】
#   同一个项目现在可以开好几个终端，标题是这么起的：
#       主线   WaifuCode · 项目名
#       分线   WaifuCode · 项目名 · 登录页表单校验
#   主线标题是分线标题的**前缀**。拿主线标题去 Contains，会一头撞上分线那个窗口 ——
#   于是「把刚开的主线窗口收起来」变成了「把你正开着的分线窗口收起来」，
#   或者点 A 跳出 B。
#
#   所以扫窗口时**两个候选都记下来**：精确相等的优先，没有精确的才退回包含。
#   精确这条几乎总能命中 —— 窗口刚建出来时标题就是我们设的那个。
function Find-Target {
  $script:found = [IntPtr]::Zero
  $script:foundTitle = ''
  $script:loose = [IntPtr]::Zero
  $script:looseTitle = ''

  $callback = [Waifu.Win+EnumWindowsProc] {
    param([IntPtr]$h, [IntPtr]$l)

    if (-not [Waifu.Win]::IsWindowVisible($h)) { return $true }

    if ($script:ProcessId -gt 0) {
      $pidOut = 0
      [void][Waifu.Win]::GetWindowThreadProcessId($h, [ref]$pidOut)
      if ($pidOut -ne $script:ProcessId) { return $true }
      $t = Get-WindowTitle $h
      if ($t -eq '') { return $true }   # 进程可能有隐藏的消息窗口，没标题的跳过
      $script:found = $h
      $script:foundTitle = $t
      return $false
    }

    $t = Get-WindowTitle $h
    if (-not $t) { return $true }

    if ($t -eq $script:Title) {
      $script:found = $h
      $script:foundTitle = $t
      return $false            # 精确命中，不用再找了
    }

    # 包含只当备胎，而且**只留第一个** —— 继续扫，万一后面有精确的。
    # -Exact 时**根本不留兜底**：发键这条路只认精确窗口，宁可找不到也不认错人
    if (-not $script:Exact -and $script:loose -eq [IntPtr]::Zero -and $t.Contains($script:Title)) {
      $script:loose = $h
      $script:looseTitle = $t
    }
    return $true
  }

  [void][Waifu.Win]::EnumWindows($callback, [IntPtr]::Zero)

  if ($script:found -eq [IntPtr]::Zero -and $script:loose -ne [IntPtr]::Zero) {
    $script:found = $script:loose
    $script:foundTitle = $script:looseTitle
  }
  return $script:found
}

# 窗口是异步创建的（尤其 wt：wt.exe 只是转发器，真窗口由 WindowsTerminal.exe 建），
# 所以要给它一点时间。WaitMs 为 0 就是只找一次
$deadline = (Get-Date).AddMilliseconds([Math]::Max(0, $WaitMs))
do {
  $h = Find-Target
  if ($h -ne [IntPtr]::Zero) { break }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 60
} while ($true)

if ($h -eq [IntPtr]::Zero) {
  Write-Output 'NOTFOUND'
  exit 1
}

# 前台真的是它了，就把确认键送过去（远程放行用）。
# 发键前最后再核一次前台 —— 不是它就绝不发：按键砸进用户正开着的
# 别的窗口，比不发糟得多。
function Send-KeysIfAsked([IntPtr]$hwnd) {
  if (-not $script:SendKeys -and -not $script:PasteStdin -and -not $script:PasteB64) { return }
  # -PasteStdin：要送进去的是一整句话（中文、符号都可能有）。
  # SendKeys 发不了中文，而 {}()+^%~ 在它的语法里全是控制符 —— 所以改走剪贴板。
  # 用完把剪贴板还回去：用户手上那份复制的东西不该被我们悄悄换掉。
  $restore = $null
  $paste = $false
  if ($script:PasteB64) {
    # base64 进来的才是没被编码转换糟蹋过的原文（stdin 那条会被按 GBK 解，
    # 中文当场变乱码 —— 实测过，这是用户看到的那个坏）
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($script:PasteB64))
    $paste = $true
  } elseif ($script:PasteStdin) {
    $text = [Console]::In.ReadToEnd()
    $paste = $true
  }
  if ($paste) {
    if (-not $text) { Write-Output 'EMPTY'; exit 3 }
    try { $restore = Get-Clipboard -Raw -ErrorAction Stop } catch { $restore = $null }
    Set-Clipboard -Value $text
  }
  Start-Sleep -Milliseconds 350
  if ([Waifu.Win]::GetForegroundWindow() -ne $hwnd) {
    Write-Output ('BLOCKED ' + $script:foundTitle)
    exit 2
  }
  $sh = New-Object -ComObject WScript.Shell
  if ($paste) {
    $sh.SendKeys('^v')
    Start-Sleep -Milliseconds 260
    $sh.SendKeys('{ENTER}')
    Start-Sleep -Milliseconds 260
    if ($null -ne $restore) { try { Set-Clipboard -Value $restore } catch { } }
  } else {
    $sh.SendKeys($script:SendKeys)
  }
  Write-Output ('TITLE64 ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script:foundTitle)))
  Write-Output ('SENT ' + $script:foundTitle)
  exit 0
}

# --- 藏起来 -----------------------------------------------------------------
if ($Minimize) {
  [void][Waifu.Win]::ShowWindow($h, 6)   # SW_MINIMIZE
  Write-Output ('MINIMIZED ' + $script:foundTitle)
  exit 0
}

# --- 捞到前面来 -------------------------------------------------------------

# 最小化的先恢复，否则「置顶」只是把一个图标提到前面
if ([Waifu.Win]::IsIconic($h)) {
  [void][Waifu.Win]::ShowWindow($h, 9)  # SW_RESTORE
}

# 兜底：窗口要是在你看不见的坐标上（拔掉过外接屏、被别的程序挪出去过），
# 恢复之后你还是看不见它，表现就是「点了没反应」。发现了就挪回来。
#
# 注：本来想靠 `wt --pos 30000,30000` 把后台窗口开在屏幕外（那样连闪都不闪），
# 实测 wt 会把坐标夹回桌面内（两块 1920 的屏，30000 被夹成 1912），这条路不通。
# 所以这段现在纯粹是兜底。
$r = New-Object Waifu.Win+RECT
if ([Waifu.Win]::GetWindowRect($h, [ref]$r)) {
  if ($r.Left -ge $OFFSCREEN_MARK -or $r.Top -ge $OFFSCREEN_MARK) {
    $w = $r.Right - $r.Left
    $ht = $r.Bottom - $r.Top
    # SWP_NOZORDER(0x4) | SWP_NOACTIVATE(0x10)
    [void][Waifu.Win]::SetWindowPos($h, [IntPtr]::Zero, 80, 60, $w, $ht, 0x14)
  }
}

# 借当前前台窗口的线程资格来抢前台，绕过系统的前台锁
$fgWin = [Waifu.Win]::GetForegroundWindow()
$fgPid = 0
$fgThread = [Waifu.Win]::GetWindowThreadProcessId($fgWin, [ref]$fgPid)
$myThread = [Waifu.Win]::GetCurrentThreadId()

$attached = $false
if ($fgThread -ne 0 -and $fgThread -ne $myThread) {
  $attached = [Waifu.Win]::AttachThreadInput($myThread, $fgThread, $true)
}

[void][Waifu.Win]::BringWindowToTop($h)
$ok = [Waifu.Win]::SetForegroundWindow($h)

if ($attached) {
  [void][Waifu.Win]::AttachThreadInput($myThread, $fgThread, $false)
}

if ($ok) {
  Send-KeysIfAsked $h
  Write-Output ('OK ' + $script:foundTitle)
  exit 0
}

# SetForegroundWindow 回 false 也不一定真失败（有时窗口其实已经上来了），
# 再核一遍当前前台是不是它
Start-Sleep -Milliseconds 120
if ([Waifu.Win]::GetForegroundWindow() -eq $h) {
  Send-KeysIfAsked $h
  Write-Output ('OK ' + $script:foundTitle)
  exit 0
}

Write-Output ('BLOCKED ' + $script:foundTitle)
exit 2
