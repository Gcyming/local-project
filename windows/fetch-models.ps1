<#
.SYNOPSIS
    一键下载模型（Windows 版，走 hf-mirror.com 国内镜像，curl.exe 断点续传）。
.DESCRIPTION
    下载 BGE-M3 Q8_0（嵌入，635MB）+ Qwen3-1.7B Q8_0（对话，1.83GB）到 models/。
    完全镜像 linux/fetch-models.sh 逻辑，纯 PowerShell + curl.exe（Win10 自带）。
.PARAMETER ChatOnly
    只下对话模型（已有嵌入模型时）。
.PARAMETER BgeOnly
    只下嵌入模型。
.EXAMPLE
    pwsh -File windows/fetch-models.ps1
    pwsh -File windows/fetch-models.ps1 --ChatOnly
#>
[CmdletBinding()]
param(
    [switch]$ChatOnly,
    [switch]$BgeOnly
)

$ScriptDir = Split-Path $MyInvocation.MyCommand.Path -Parent
$Root      = Split-Path (Split-Path $ScriptDir -Parent) -Parent
$Root      = (Resolve-Path $Root).Path
Set-Location $Root

$DownloadBge = (-not $ChatOnly.IsPresent)
$DownloadChat = (-not $BgeOnly.IsPresent)

mkdir -Force (Join-Path $Root 'models\BGE-M3') | Out-Null
mkdir -Force (Join-Path $Root 'models\chat')    | Out-Null

function Get-RemoteSize {
    param([string]$Url)
    # 用 python 解析 Content-Length 响应头，避免正则陷阱
    & py -c "
import sys, urllib.request
url = sys.argv[1]
try:
    r = urllib.request.urlopen(url, timeout=15)
    print(r.headers.get('content-length', ''))
except Exception as e:
    print('', end='')
" $Url 2>$null
}

function Fetch-Model {
    param([string]$Url, [string]$Out)
    Write-Host "[models] $Out"
    $Remote = Get-RemoteSize -Url $Url
    if (Test-Path $Out) {
        $LocalSize = (Get-Item $Out).Length
        if ($Remote -match '^\d+$' -and $LocalSize -ge [int]$Remote -and $LocalSize -gt 0) {
            Write-Host "  已完整存在（$LocalSize 字节），跳过"
            return
        }
        Write-Host "  续传（本地 $LocalSize / 远端 ${Remote} 字节）..."
    } else {
        Write-Host "  下载中..."
    }
    curl.exe -fL --retry 5 --retry-delay 3 -C - -o $Out "$Url"
    $Final = (Get-Item $Out).Length
    Write-Host "  完成: $Final 字节"
}

if ($DownloadBge) {
    Fetch-Model `
        -Url "https://hf-mirror.com/ggml-org/bge-m3-Q8_0-GGUF/resolve/main/bge-m3-q8_0.gguf" `
        -Out (Join-Path $Root 'models\BGE-M3\bge-m3-q8_0.gguf')
}

if ($DownloadChat) {
    Fetch-Model `
        -Url "https://hf-mirror.com/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf" `
        -Out (Join-Path $Root 'models\chat\qwen3-1.7b-q8_0.gguf')
}

Write-Host ""
Write-Host "[models] 全部就绪："
Get-ChildItem (Join-Path $Root 'models\BGE-M3\*.gguf'), (Join-Path $Root 'models\chat\*.gguf') -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  $($_.Name)`t$($_.Length) 字节"
}
Write-Host "启动：pwsh windows\run-server.ps1（后端）+ pwsh windows\run-cli.ps1（CLI）"
