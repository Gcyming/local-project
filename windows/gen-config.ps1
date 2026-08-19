<#
.SYNOPSIS
    从 slime.toml.linux 模板生成项目根 slime.toml（Windows 版）。
.DESCRIPTION
    模板是 linux/slime.toml.linux（含 @PROJECT_ROOT@ 占位符），
    生成到 $ROOT/slime.toml。与 linux/scripts/gen-config.sh 逻辑一致，纯 PowerShell。
.PARAMETER Root
    指定仓库根（默认取本脚本所在目录的上两级：windows/.. -> project root）。
.PARAMETER Force
    覆盖已存在的 slime.toml（默认备份为 slime.toml.bak 后生成）。
.EXAMPLE
    pwsh -File windows/gen-config.ps1 --root "D:\project" --force
#>
[CmdletBinding()]
param(
    [string]$Root = "",
    [switch]$Force
)

$ScriptDir = Split-Path $MyInvocation.MyCommand.Path -Parent
$ScriptDir = (Resolve-Path $ScriptDir).Path

if (-not $Root) {
    # windows/ 的上两级是仓库根
    $Root = Split-Path (Split-Path $ScriptDir -Parent) -Parent
}
$Root = (Resolve-Path $Root).Path

$Template = Join-Path $ScriptDir "..\linux\slime.toml.linux"
$Target   = Join-Path $Root "slime.toml"

if (-not (Test-Path $Template)) {
    Write-Error "[gen-config] ERROR: 模板不存在: $Template"
    exit 1
}

if (Test-Path $Target) {
    if (-not $Force) {
        Write-Host "[gen-config] 已存在 $Target，跳过（用 --force 覆盖，原文件备份为 slime.toml.bak）"
        exit 0
    }
    Copy-Item $Target "$Target.bak" -Force
    Write-Host "[gen-config] 已备份原配置 → $Target.bak"
}

# @PROJECT_ROOT@ → 仓库根绝对路径（Windows 路径含 \，字符串替换安全）
$Content = Get-Content $Template -Raw
$Content = $Content.Replace('@PROJECT_ROOT@', $Root)
[System.IO.File]::WriteAllText($Target, $Content, [System.Text.Encoding]::UTF8)

# 创建模型与 bin 目录约定
mkdir -Force (Join-Path $Root 'models\BGE-M3') | Out-Null
mkdir -Force (Join-Path $Root 'models\chat')      | Out-Null
mkdir -Force (Join-Path $Root 'llama.cpp\build\bin') | Out-Null

Write-Host "[gen-config] 已生成: $Target"
Write-Host "[gen-config] 模型目录约定（请放置文件）："
Write-Host "  $Root\models\BGE-M3\bge-m3-q8_0.gguf   （嵌入模型）"
Write-Host "  $Root\models\chat\*.gguf               （Chat 模型）"
Write-Host "  $Root\llama.cpp\build\bin\llama-server.exe （llama.cpp 预编译产物，setup.ps1 自动处理）"
