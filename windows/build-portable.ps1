#!/usr/bin/env pwsh
# windows/build-portable.ps1 — 构建 Windows 便携发行包（免安装任何依赖）。
#
# 产物：dist/slime-win-x64.zip（自包含 Node 运行时 + Python venv + llama-server + 模型）
# 接收方只需：解压 → .\run-cli.bat（或 .\run-server.bat / .\run-gui.bat）
#
# 用法：
#   pwsh -File windows/build-portable.ps1                    # 完整构建（含模型）
#   pwsh -File windows/build-portable.ps1 --SkipLlama       # 跳过 llama-server（需自带）
#   pwsh -File windows/build-portable.ps1 --SkipModels      # 不打包模型（包约 800MB）
#   pwsh -File windows/build-portable.ps1 --KeepStaging     # 保留 staging 目录便于调试
set strictmode -version latest
$ErrorActionPreference = "Stop"

param(
    [switch]$SkipLlama,
    [switch]$SkipModels,
    [switch]$KeepStaging
)

$ScriptDir = Split-Path $MyInvocation.MyCommand.Path -Parent
$Root = Split-Path (Split-Path $ScriptDir -Parent) -Parent
$Root = (Resolve-Path $Root).Path
$Dist = Join-Path $Root "dist"
$KitName = "slime-win-x64"
$Kit = Join-Path $Dist $KitName

Set-Location $Root

Write-Host "================================================================"
Write-Host "  slime Windows 便携发行包构建"
Write-Host "  输出: $Kit -> $Dist\$KitName.zip"
Write-Host "================================================================"

# ── 前置检查 ────────────────────────────────────────────────────────
foreach ($cmd in @("git", "curl.exe", "python", "pwsh")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Error "[portable] ERROR: 缺少 $cmd"
        exit 1
    }
}
Write-Host "[portable] 前置依赖 OK"

# ── 1. 源码（git archive：仅已提交文件） ───────────────────────────
if (Test-Path $Kit) { Remove-Item $Kit -Recurse -Force }
New-Item -ItemType Directory -Force $Kit | Out-Null
git archive HEAD | tar xf - -C $Kit 2>$null
# git archive on Windows may not produce tar; fallback: robocopy
if (-not (Test-Path (Join-Path $Kit "slime_server.py"))) {
    Write-Warning "[portable] git archive 失败，改用 robocopy（会包含 .git）"
    Remove-Item $Kit -Recurse -Force
    robocopy $Root $Kit /E /XD .git node_modules .venv __pycache__ gui\node_modules gui\.venv gui\dist gui\release gui\out ".pnpm-store" dist release-linux release-win portables 2>$null | Out-Null
}
Write-Host "[portable] 源码就绪"

# ── 2. Node 运行时（LTS x64，从 nodejs.org 下载 portable tar.gz） ──
$NodeDir = Join-Path $Kit "runtime\node"
New-Item -ItemType Directory -Force (Split-Path $NodeDir -Parent) | Out-Null
$NodeVer = py -c "
import json, urllib.request
d = json.load(urllib.request.urlopen('https://nodejs.org/dist/index.json', timeout=30))
for e in d:
    if e.get('lts'):
        print(e['version']); break
" 2>$null
if (-not $NodeVer) {
    Write-Warning "[portable] 无法获取 Node LTS 版本，跳过（需手动放入 runtime/node/）"
} else {
    $NodeUrl = "https://nodejs.org/dist/$NodeVer/node-$NodeVer-win-x64.zip"
    Write-Host "[portable] 下载 Node $NodeVer ..."
    $NodeZip = Join-Path $env:TEMP "node.zip"
    curl.exe -fSL --max-time 180 -o $NodeZip $NodeUrl 2>&1 | Out-Null
    if (Test-Path $NodeZip) {
        Expand-Archive -Path $NodeZip -DestinationPath $NodeDir -Force
        Rename-Item (Get-ChildItem $NodeDir -Directory | Where-Object { $_.Name -match "^node-$NodeVer-win" }) "node" -Force -ErrorAction SilentlyContinue
        Remove-Item $NodeZip -Force
        Write-Host "[portable] Node 就绪: $(Join-Path $NodeDir 'bin\node.exe' | Split-Path -Parent)"
    } else {
        Write-Warning "[portable] Node 下载失败"
    }
}

# ── 3. Python venv（--copies 可迁移，基于系统 Python） ─────────────
$PyDir = Join-Path $Kit "runtime\python"
$VenvDir = Join-Path $Kit "runtime\venv"
New-Item -ItemType Directory -Force $PyDir | Out-Null
Write-Host "[portable] 创建 Python venv (--copies 可迁移)..."
py -m venv --copies $VenvDir
Write-Host "[portable] venv 就绪: $VenvDir"

# ── 4. pip install requirements ────────────────────────────────────
Write-Host "[portable] pip install requirements.txt..."
& "$VenvDir\Scripts\pip.exe" install --upgrade pip -q
& "$VenvDir\Scripts\pip.exe" install -r (Join-Path $Root "requirements.txt") -q
Write-Host "[portable] pip install OK"

# ── 5. pnpm install（用内置 Node） ─────────────────────────────────
$NodeBin = Join-Path $NodeDir "bin"
$Env:PATH = "$NodeBin;$Env:PATH"
Write-Host "[portable] pnpm install..."
# pnpm 可能不存在于新 node；用 npm i -g pnpm
& "$NodeBin\npm.cmd" install -g pnpm -q 2>$null
& pnpm install 2>$null
Write-Host "[portable] pnpm install OK"

# ── 6. GUI 预构建 ──────────────────────────────────────────────────
Write-Host "[portable] 构建 GUI 渲染产物..."
Push-Location (Join-Path $Kit "gui")
& "$NodeBin\npx.cmd" electron-vite build 2>$null
Pop-Location
Write-Host "[portable] GUI 预构建完成"

# ── 7. llama-server（预编译 CPU x64，同 Linux 代理链）──────────────
if (-not $SkipLlama.IsPresent) {
    Write-Host "[portable] 获取 llama-server.exe..."
    $LlamaDir = Join-Path $Kit "llama.cpp\build\bin"
    New-Item -ItemType Directory -Force $LlamaDir | Out-Null
    $LlamaBin = Join-Path $LlamaDir "llama-server.exe"
    if (Test-Path $LlamaBin) {
        Write-Host "[portable] llama-server.exe 已存在，跳过"
    } else {
        $GH_Base = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
        $Latest = curl.exe -fsSL --max-time 30 $GH_Base 2>$null
        if (-not $Latest) {
            foreach ($proxy in @("https://gh-proxy.com/", "https://ghproxy.net/")) {
                $Latest = curl.exe -fsSL --max-time 30 "$proxy$GH_Base" 2>$null
                if ($Latest) { break }
            }
        }
        if ($Latest) {
            $Asset = & py -c "
import json,sys
try:
    d=json.loads(sys.argv[1])
    for a in d.get('assets',[]):
        if 'bin-win-cpu-x64.zip' in a.get('name',''):
            print(a['browser_download_url']); sys.exit(0)
except Exception: pass
sys.exit(1)
" $Latest 2>$null
            if ($Asset) {
                $TmpZip = Join-Path $env:TEMP "llama-win.zip"
                curl.exe -fSL --max-time 180 -o $TmpZip $Asset 2>&1 | Out-Null
                if (Test-Path $TmpZip) {
                    Expand-Archive -Path $TmpZip -DestinationPath $LlamaDir -Force
                    Remove-Item $TmpZip -Force
                    if (Test-Path $LlamaBin) { Write-Host "[portable] llama-server.exe 就绪 ($([math]::Round((Get-Item $LlamaBin).Length/1MB,1)) MB)" }
                }
            }
        }
        if (-not (Test-Path $LlamaBin)) {
            Write-Warning "[portable] WARNING: llama-server.exe 缺失（网络受限时请手动放入 $LlamaBin）"
        }
    }
} else {
    Write-Host "[portable] --SkipLlama：跳过"
}

# ── 8. 模型下载（默认打包）─────────────────────────────────────────
if (-not $SkipModels.IsPresent) {
    Write-Host "[portable] 下载模型（hf-mirror 镜像，断点续传）..."
    $BgeOut = Join-Path $Kit "models\BGE-M3\bge-m3-q8_0.gguf"
    $QwenOut = Join-Path $Kit "models\chat\qwen3-1.7b-q8_0.gguf"
    New-Item -ItemType Directory -Force (Split-Path $BgeOut -Parent) | Out-Null
    New-Item -ItemType Directory -Force (Split-Path $QwenOut -Parent) | Out-Null

    function Fetch-Model($Url, $Out) {
        Write-Host "  $Out"
        $Remote = & py -c "
import sys,urllib.request
try:
    r = urllib.request.urlopen(sys.argv[1], timeout=15)
    print(r.headers.get('content-length',''))
except Exception: print('')
" $Url 2>$null
        if (Test-Path $Out) {
            $LocalSize = (Get-Item $Out).Length
            if ($Remote -match '^\d+$' -and $LocalSize -ge [int]$Remote -and $LocalSize -gt 0) {
                Write-Host "    已完整存在（$LocalSize 字节），跳过"
                return
            }
            Write-Host "    续传 ($LocalSize / ${Remote}) 字节..."
        } else {
            Write-Host "    下载中..."
        }
        curl.exe -fL --retry 5 --retry-delay 3 -C - -o $Out $Url 2>&1 | Out-Null
        $Final = (Get-Item $Out).Length
        Write-Host "    完成: $Final 字节"
    }

    Fetch-Model "https://hf-mirror.com/ggml-org/bge-m3-Q8_0-GGUF/resolve/main/bge-m3-q8_0.gguf" $BgeOut
    Fetch-Model "https://hf-mirror.com/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf" $QwenOut
    Write-Host "[portable] 模型就绪"
} else {
    Write-Host "[portable] --SkipModels：模型不打包"
    New-Item -ItemType Directory -Force (Join-Path $Kit "models\BGE-M3") | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $Kit "models\chat") | Out-Null
}

# ── 9. 配置 + 入口脚本 ─────────────────────────────────────────────
$GenConfig = Join-Path $ScriptDir "gen-config.ps1"
& $GenConfig --root $Kit --force

# run-cli.bat
@"
@echo off
chcp 65001 >nul
set KIT=%~dp0
set PATH=%KIT%runtime\node\bin;%KIT%runtime\venv\Scripts;%PATH%
if not exist "%KIT%slime.toml" (
    powershell -File "%KIT%windows\gen-config.ps1" --root "%KIT%" --force
)
cd /d "%KIT%"
py slime_cli.py %*
"@ | Set-Content (Join-Path $Kit "run-cli.bat") -Encoding ASCII

@"
@echo off
chcp 65001 >nul
set KIT=%~dp0
set PATH=%KIT%runtime\node\bin;%KIT%runtime\venv\Scripts;%PATH%
if not exist "%KIT%slime.toml" (
    powershell -File "%KIT%windows\gen-config.ps1" --root "%KIT%" --force
)
cd /d "%KIT%"
py slime_server.py %*
"@ | Set-Content (Join-Path $Kit "run-server.bat") -Encoding ASCII

@"
@echo off
chcp 65001 >nul
set KIT=%~dp0
set PATH=%KIT%runtime\node\bin;%KIT%runtime\venv\Scripts;%PATH%
set ELECTRON_DISABLE_SANDBOX=1
if not exist "%KIT%slime.toml" (
    powershell -File "%KIT%windows\gen-config.ps1" --root "%KIT%" --force
)
cd /d "%KIT%\gui"
"%KIT%runtime\node\bin\node.exe" "%KIT%node_modules\electron\cli.js" .
"@ | Set-Content (Join-Path $Kit "run-gui.bat") -Encoding ASCII

Write-Host "[portable] 入口脚本就绪: run-cli.bat / run-server.bat / run-gui.bat"

# ── 10. 打包 ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "[portable] 打包 $KitName.zip ..."
$ZipPath = Join-Path $Dist "$KitName.zip"
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path "$Kit\*" -DestinationPath $ZipPath -Force
$ZipSize = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
Write-Host ""
Write-Host "================================================================"
Write-Host "  构建完成: $ZipPath ($ZipSize MB)"
Write-Host ""
Write-Host "  接收方使用（零依赖）："
Write-Host "    解压 zip → 双击 run-cli.bat（或 cmd 下 run-server.bat）"
if ($SkipModels) {
    Write-Host "    模型需自备：运行 run-cli.bat 后按提示放入 models/"
} else {
    Write-Host "    已内置模型，开箱即用"
}
Write-Host "================================================================"

if (-not $KeepStaging.IsPresent) {
    Write-Host "[portable] 清理 staging 目录..."
    Remove-Item $Kit -Recurse -Force
}
