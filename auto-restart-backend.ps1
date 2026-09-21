<#
=====================================================================
 校园跑腿「后端自动重启 + cpolar 公网地址自动同步」守护脚本
---------------------------------------------------------------------
 功能：
   1) 每隔 N 秒检测后端 http://127.0.0.1:3000/api/health，
      连续失败 3 次自动重新拉起后端（node src/app.js），实现「挂了就重启」
   2) 自动获取 cpolar 当前公网地址，并写入小程序
      miniprogram/utils/request.js 的 BASE_URL（写入前自动备份 .bak）
   3) MySQL80 服务未启动时自动尝试启动
   4) 运行日志写入 脚本所在目录\logs\

 用法：
   双击「启动后端守护.bat」                    -> 前台可见窗口，Ctrl+C 停止
   ... -NoWatch                                -> 只检查/启动一次就退出
   ... -CpolarUrl https://xxx.cpolar.top       -> 指定 cpolar 地址并立即写入小程序

 cpolar 地址从哪里自动获取？（按顺序尝试，每个都会先请求 <地址>/api/health 验证）
   1. 脚本所在目录\cpolar-url.txt 里手动填写的地址（最稳，推荐）
   2. 小程序 request.js 里当前已配置的地址（能用就不改）
   3. cpolar 日志（%USERPROFILE%\.cpolar\logs）里最近出现过的 https://xxx.cpolar.top
   全部失败时：打开 http://localhost:9200（Cpolar Web UI）→ 隧道管理，
   复制 3000 端口那条隧道的 https 地址，粘贴到 cpolar-url.txt 即可自动生效。
=====================================================================
#>
param(
  [string]$CpolarUrl = '',
  [int]$CheckIntervalSec = 10,
  [int]$FailThreshold = 3,
  [switch]$NoWatch
)

$ErrorActionPreference = 'Continue'

# ------------------------------ 基础路径 ------------------------------
$Root          = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir    = Join-Path $Root 'backend'
$LogDir        = Join-Path $Root 'logs'
$RequestJs     = Join-Path $Root 'miniprogram\utils\request.js'
$CpolarUrlFile = Join-Path $Root 'cpolar-url.txt'
$Port          = 3000
$HealthUrl     = "http://127.0.0.1:$Port/api/health"

if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$WatchLog = Join-Path $LogDir ('keep-alive-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))

# 默认的 cpolar-url.txt 内容（文件不存在时自动生成，方便用户直接照着填）
$DefaultUrlFile = @"
# ============================================================
#  cpolar 公网地址配置文件
# ------------------------------------------------------------
#  【什么时候需要改这里】
#   自动检测失败（脚本提示「未能自动确认 cpolar 公网地址」）时，
#   把 cpolar 的公网地址填到下面这一行（以 https:// 开头），
#   保存后守护脚本会在 1 分钟内自动生效并写入小程序。
#
#  【地址在哪里看】
#   1) 浏览器打开 http://localhost:9200  （Cpolar Web UI）
#   2) 左侧「隧道管理」→ 找到本地端口 3000 的那条隧道
#   3) 复制它后面的 https 地址（形如 https://xxxx.r36.cpolar.top）
#   4) 粘贴到本文件 #URL# 那一行，保存即可
# ============================================================

#URL#
"@

# ------------------------------ 日志输出 ------------------------------
function Write-Log {
  param([string]$Msg, [string]$Level = 'INFO')
  $line = '[{0}][{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Msg
  switch ($Level) {
    'ERROR' { Write-Host $line -ForegroundColor Red }
    'WARN'  { Write-Host $line -ForegroundColor Yellow }
    'OK'    { Write-Host $line -ForegroundColor Green }
    default { Write-Host $line }
  }
  try { Add-Content -LiteralPath $WatchLog -Value $line -Encoding UTF8 } catch { }
}

function Normalize-Url {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($Url)) { return '' }
  $u = $Url.Trim().Trim('"').Trim("'")
  if ($u -notmatch '^https?://') { return '' }
  return $u.TrimEnd('/')
}

# ------------------------------ 后端进程 ------------------------------
function Get-ListenPid {
  param([int]$LocalPort)
  $conns = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
  if ($conns) { return [int](($conns | Select-Object -First 1).OwningProcess) }
  return 0
}

function Test-BackendHealth {
  param([string]$BaseUrl = '')
  if ([string]::IsNullOrWhiteSpace($BaseUrl)) { $BaseUrl = "http://127.0.0.1:$Port" }
  try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/health" -UseBasicParsing -TimeoutSec 8
    return ($resp.StatusCode -eq 200 -and $resp.Content -match '"code"\s*:\s*200')
  } catch {
    return $false
  }
}

function Stop-Backend {
  $listenPid = Get-ListenPid -LocalPort $Port
  if ($listenPid -gt 0) {
    Write-Log "正在停止旧后端进程（PID $listenPid）..."
    Stop-Process -Id $listenPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    return $true
  }
  return $false
}

function Start-Backend {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw '未找到 node 命令，请先安装 Node.js 并加入 PATH' }

  # 用 WMI 拉起的进程独立于本脚本，脚本退出后后端仍然存活
  # 【为什么按天分文件】cmd 的 ">>" 重定向会把日志文件独占锁定，
  #   运行期间任何清理程序都删不掉它（Windows 返回 EBUSY）。
  #   改成 logs\server-yyyyMMdd.out.log 后，一旦重启就会换用新文件，
  #   旧文件被释放，随后由每天 03:00 的垃圾清理任务按保留期回收。
  #   这里刻意用「相对路径」（当前目录已 cd 到 backend），避免路径含空格引发 cmd 引号解析问题。
  $backendLogDir = Join-Path $BackendDir 'logs'
  if (-not (Test-Path -LiteralPath $backendLogDir)) { New-Item -ItemType Directory -Path $backendLogDir -Force | Out-Null }
  $stamp  = Get-Date -Format 'yyyyMMdd'
  $outLog = 'logs\server-{0}.out.log' -f $stamp
  $errLog = 'logs\server-{0}.err.log' -f $stamp
  $cmdLine = 'cmd /c "cd /d "' + $BackendDir + '" && node src\app.js >> ' + $outLog + ' 2>> ' + $errLog + '"'
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdLine }
  if ($result.ReturnValue -ne 0) { throw "拉起后端进程失败，WMI 返回码 $($result.ReturnValue)" }
  return [int]$result.ProcessId
}

function Ensure-MySql {
  $svc = Get-Service -Name 'MySQL80' -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -ne 'Running') {
    Write-Log 'MySQL80 服务未运行，尝试自动启动...' 'WARN'
    try {
      Start-Service -Name 'MySQL80'
      Start-Sleep -Seconds 4
      Write-Log 'MySQL80 已启动' 'OK'
    } catch {
      Write-Log "MySQL80 启动失败：$($_.Exception.Message)（请右键以管理员身份运行本脚本）" 'ERROR'
    }
  }
}

# ------------------------------ cpolar 地址 ------------------------------
function Get-UrlFromFile {
  if (-not (Test-Path -LiteralPath $CpolarUrlFile)) { return '' }
  $lines = Get-Content -LiteralPath $CpolarUrlFile -Encoding UTF8 -ErrorAction SilentlyContinue
  foreach ($line in $lines) {
    $t = "$line".Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $u = Normalize-Url $t
    if ($u) { return $u }
  }
  return ''
}

function Save-UrlToFile {
  param([string]$Url)
  if (-not (Test-Path -LiteralPath $CpolarUrlFile)) { return }
  $text = [System.IO.File]::ReadAllText($CpolarUrlFile, [System.Text.Encoding]::UTF8)
  $new = [regex]::Replace($text, '(?m)^#URL#\s*$', "#URL# $Url")
  $new = [regex]::Replace($new, '(?m)^#URL#\s+https?://\S+\s*$', "#URL# $Url")
  if ($new -ne $text) {
    [System.IO.File]::WriteAllText($CpolarUrlFile, $new, (New-Object System.Text.UTF8Encoding($true)))
  }
}

function Get-ConfiguredBaseUrl {
  if (-not (Test-Path -LiteralPath $RequestJs)) { return '' }
  $text = [System.IO.File]::ReadAllText($RequestJs, [System.Text.Encoding]::UTF8)
  $m = [regex]::Match($text, "let\s+BASE_URL\s*=\s*'([^']*)'")
  if ($m.Success) { return (Normalize-Url $m.Groups[1].Value) }
  return ''
}

function Set-ConfiguredBaseUrl {
  param([string]$Url)
  if (-not (Test-Path -LiteralPath $RequestJs)) { return $false }
  $text = [System.IO.File]::ReadAllText($RequestJs, [System.Text.Encoding]::UTF8)
  $new = [regex]::Replace($text, "let\s+BASE_URL\s*=\s*'[^']*'", "let BASE_URL = '$Url'")
  if ($new -eq $text) { return $false }
  # 先备份，再以 UTF-8（无 BOM）写回，保持小程序源码格式不变
  $backup = Join-Path $LogDir ('request.js.{0}.bak' -f (Get-Date -Format 'yyyyMMddHHmmss'))
  [System.IO.File]::WriteAllText($backup, $text, (New-Object System.Text.UTF8Encoding($false)))
  [System.IO.File]::WriteAllText($RequestJs, $new, (New-Object System.Text.UTF8Encoding($false)))
  return $true
}

function Get-UrlFromCpolarLog {
  $cpolarLogDir = Join-Path $env:USERPROFILE '.cpolar\logs'
  if (-not (Test-Path -LiteralPath $cpolarLogDir)) { return '' }
  $files = Get-ChildItem -LiteralPath $cpolarLogDir -Filter 'cpolar_service.log*' -File -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending | Select-Object -First 2
  foreach ($f in $files) {
    try {
      $fs = [System.IO.File]::Open($f.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      try {
        $len  = $fs.Length
        $take = [Math]::Min([int64]$len, [int64](300KB))
        $fs.Seek($len - $take, [System.IO.SeekOrigin]::Begin) | Out-Null
        $buf = New-Object byte[] $take
        $fs.Read($buf, 0, $take) | Out-Null
        $text = [System.Text.Encoding]::UTF8.GetString($buf)
      } finally { $fs.Close() }
    } catch { continue }

    $matches = [regex]::Matches($text, 'https://[A-Za-z0-9\-\.]+\.cpolar\.(?:top|cn|io)')
    if ($matches.Count -gt 0) { return (Normalize-Url $matches[$matches.Count - 1].Value) }
  }
  return ''
}

function Sync-CpolarUrl {
  param([string]$Preferred = '')

  $current = Get-ConfiguredBaseUrl
  $candidates = @()
  if ($Preferred) { $candidates += (Normalize-Url $Preferred) }
  $candidates += (Get-UrlFromFile)
  if ($current) { $candidates += $current }
  $candidates += (Get-UrlFromCpolarLog)
  $candidates = @($candidates | Where-Object { $_ } | Select-Object -Unique)

  foreach ($u in $candidates) {
    if (Test-BackendHealth -BaseUrl $u) {
      if ($u -ne $current) {
        if (Set-ConfiguredBaseUrl -Url $u) {
          Write-Log "已自动把 cpolar 公网地址写入小程序 BASE_URL：$u" 'OK'
          Write-Log '小程序源码已变更，微信开发者工具会自动重新编译；真机/体验版请重新「预览」或「上传」。' 'INFO'
        }
      } else {
        Write-Log "cpolar 公网地址正常（小程序已指向该地址）：$u"
      }
      Save-UrlToFile -Url $u
      return $u
    }
  }

  Write-Log '未能自动确认 cpolar 公网地址（本机后端正常，但公网地址不可用）。' 'WARN'
  Write-Log '请打开 http://localhost:9200 →「隧道管理」，复制 3000 端口隧道的 https 地址，' 'WARN'
  Write-Log "粘贴到 $CpolarUrlFile 后会自动生效（脚本每秒轮询，无需重启）。" 'WARN'
  return ''
}

# ============================== 启动自检 ==============================
Write-Log '=================================================='
Write-Log '校园跑腿后端守护脚本启动'
Write-Log "检查间隔：$CheckIntervalSec 秒；连续失败 $FailThreshold 次自动重启"
Write-Log "后端目录：$BackendDir"

if (-not (Test-Path -LiteralPath $CpolarUrlFile)) {
  [System.IO.File]::WriteAllText($CpolarUrlFile, $DefaultUrlFile, (New-Object System.Text.UTF8Encoding($true)))
  Write-Log "已生成 cpolar 地址配置文件：$CpolarUrlFile"
}

# ---------------- 第一轮：确保后端在跑 ----------------
Ensure-MySql
if (Test-BackendHealth) {
  Write-Log '后端已在运行，健康检查通过' 'OK'
} else {
  Write-Log '后端未运行（或健康检查失败），正在启动...' 'WARN'
  Stop-Backend | Out-Null
  try {
    $startPid = Start-Backend
    Write-Log "已拉起后端进程（cmd PID $startPid），等待服务就绪..." 
  } catch {
    Write-Log $_.Exception.Message 'ERROR'
  }
  for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Seconds 1
    if (Test-BackendHealth) { break }
  }
  if (Test-BackendHealth) { Write-Log '后端启动成功：http://localhost:3000' 'OK' }
  else { Write-Log '后端启动后健康检查仍未通过，请查看 backend\logs\server-*.err.log' 'ERROR' }
}

# ---------------- 第二轮：同步 cpolar 公网地址 ----------------
Sync-CpolarUrl -Preferred $CpolarUrl | Out-Null

if ($NoWatch) {
  Write-Log '一次性检查完成（-NoWatch），脚本退出'
  exit 0
}

# ============================== 守护循环 ==============================
# 单实例保护：避免重复双击启动多个守护进程互相抢着重启后端
$mutex = New-Object System.Threading.Mutex($false, 'Local\CampusErrandBackendKeepAlive')
if (-not $mutex.WaitOne(0)) {
  Write-Log '检测到已有守护进程在运行，本进程直接退出（无需重复启动）' 'WARN'
  exit 0
}

Write-Log '进入守护模式：后端挂掉会自动重启；Ctrl+C 可停止'
$failCount   = 0
$syncCounter = 0
$lastState   = 'up'

while ($true) {
  Start-Sleep -Seconds $CheckIntervalSec

  if (Test-BackendHealth) {
    if ($lastState -eq 'down') { Write-Log '后端已恢复' 'OK' }
    $lastState = 'up'
    $failCount = 0
  } else {
    $failCount++
    $lastState = 'down'
    Write-Log "后端健康检查失败（第 $failCount / $FailThreshold 次）" 'WARN'

    if ($failCount -ge $FailThreshold) {
      Write-Log '触发自动重启...' 'WARN'
      Stop-Backend | Out-Null
      Ensure-MySql
      try {
        Start-Backend | Out-Null
      } catch {
        Write-Log $_.Exception.Message 'ERROR'
      }
      Start-Sleep -Seconds 6
      if (Test-BackendHealth) { Write-Log '自动重启成功，后端已恢复' 'OK' } 
    else { Write-Log '自动重启后仍未通过健康检查，请查看 backend\logs\server-*.err.log' 'ERROR' }
      $failCount = 0
    }
  }

  # 每分钟同步一次 cpolar 公网地址（地址没变时只做一次轻量健康检查）
  $syncCounter++
  if ($syncCounter -ge [Math]::Max(1, [int](60 / [Math]::Max(1, $CheckIntervalSec)))) {
    $syncCounter = 0
    Sync-CpolarUrl | Out-Null
  }
}
