# 名刺管理サーバーを「PC起動時に自動起動」するタスクを登録します。
# ※ 管理者権限の PowerShell で実行してください（実行前に内容を確認してください）。
#   -User には共有フォルダへの読み書き権限を持つ実行用アカウント（例: CORP\svc-meishi）を指定します。
param(
  [Parameter(Mandatory = $true)][string]$User,
  [string]$AppDir = (Resolve-Path "$PSScriptRoot\..\..").Path
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'logs') | Out-Null
$cred = Get-Credential -UserName $User -Message '実行用アカウントのパスワード（タスクスケジューラに保存されます。アプリには保存しません）'
$node = Join-Path $AppDir 'runtime\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
$action = New-ScheduledTaskAction -Execute $node -Argument "dist\server\main.js --log logs\server.log" -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName 'MeishiServer' -Action $action -Trigger $trigger -Settings $settings `
  -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Description '名刺管理アプリ（社内専用）' -Force | Out-Null
Write-Host 'タスク MeishiServer を登録しました。手動起動: Start-ScheduledTask -TaskName MeishiServer'
