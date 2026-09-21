# =====================================================================
# 以管理员身份启动 MySQL80 并设置为「开机自动启动」
# 由 Codex 在排查「后端断了」时使用；也可以自己右键「以管理员身份运行」
# =====================================================================
$ErrorActionPreference = 'Continue'
$log = 'D:\miniprogram123\logs\mysql-start.log'
function W($t) { "$t" | Out-File -FilePath $log -Append -Encoding utf8 }
"=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 开始修复 MySQL80 ===" | Out-File -FilePath $log -Encoding utf8

W '[1/3] 设置 MySQL80 为开机自动启动'
& sc.exe config MySQL80 start= auto 2>&1 | ForEach-Object { W "    $_" }

W '[2/3] 启动 MySQL80 服务'
& sc.exe start MySQL80 2>&1 | ForEach-Object { W "    $_" }

W '[3/3] 等待并检查状态'
Start-Sleep -Seconds 10
$svc = Get-Service -Name MySQL80 -ErrorAction SilentlyContinue
W ("    服务当前状态：" + $svc.Status + " / 启动类型：" + $svc.StartType)

# 3306 端口是否已监听（数据库真正可用的标志）
$listen = (netstat -ano | Select-String ':3306' | Select-String 'LISTENING')
W ("    3306 端口监听：" + ($(if ($listen) { '是' } else { '否' })))
W '=== 结束 ==='