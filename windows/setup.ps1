<#
.SYNOPSIS
    slime Windows 环境一键引导（等价于 linux/setup.sh）。
.DESCRIPTION
    自动完成：venv + pip + pnpm + llama-server 预编译 + slime.toml 生成。
    加 --with-models 还会下载模型（约 2.5GB）。
.PARAMETER SkipLlama
    跳过 llama.cpp（已有预编译时）。
.PARAMETER WithModels
    环境装好后自动下载模型。
.PARAMETER NoVenv
    不建 venv，直接用系统 python。
.EXAMPLE
    pwsh -File windows/setup.ps1
    pwsh -File windows/setup.ps1 --WithModels
#>
[CmdletBinding()]
param(
    [switch]$SkipLlama,
    [switch]$WithModels,
    [switch]$NoVenv
)

$ScriptDir = Split-Path $MyInvocation.MyCommand.Path -Parent
$Root      = Split-Path (Split-Path $ScriptDir -Parent) -Parent
$Root      = (Resolve-Path $Root).Path
Set-Location $Root

function Test-Exe {
    param([string]$Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-Version {
    param([string]$Exe, [scriptblock]$Parse)
    $out = & $Exe @(& $Parse) 2>$null
    return $out.Trim()
}

function Parse-PythonVer {
    param([string]$Raw)
    if ($Raw -match '^(\d+)\.(\d+)') {
        return "v$($Matches[1]).$($Matches[2])"
    }
    return $Raw
}

Write-Host "================================================================"
Write-Host "  slime Windows 环境引导"
Write-Host "  仓库根: $Root"
Write-Host "================================================================"

# ── 前置检测 ────────────────────────────────────────────────────────
if (-not (Test-Exe py)) {
    Write-Warning "py 启动器不可用，请通过 installer.microsoft.com 安装 Python 3.10+"
} else {
    $PV = Parse-PythonVer (py -c "import sys; print(sys.version_info[0]); print(sys.version_info[1])" 2>$null | Select-Object -First 2 | Join-String -Separator '.')
    Write-Host "[setup] py: $PV"
}
if (-not (Test-Exe node)) {
    Write-Warning "node 不可用，请通过 nodejs.org 安装 >=20"
} else {
    $NV = node -p "process.version"
    Write-Host "[setup] node: $NV"
}
if (-not (Test-Exe pnpm)) {
    Write-Warning "pnpm 不可用，尝试 corepack 启用..."
    if (Test-Exe corepack) { corepack enable 2>$null; corepack prepare pnpm@latest --activate 2>$null }
    if (-not (Test-Exe pnpm)) { npm install -g pnpm 2>$null }
}
if (Test-Exe pnpm) { Write-Host "[setup] pnpm: $(pnpm -v)" }

# ── Python venv ─────────────────────────────────────────────────────
if (-not $NoVenv.IsPresent) {
    Write-Host "[setup] 创建 venv（--copies 可迁移）..."
    py -m venv --copies .venv
    $VenvPy = ".venv\Scripts\python.exe"
    & $VenvPy -m pip install --upgrade pip -q
    Write-Host "[setup] 已激活 venv: $VenvPy"
} else {
    $VenvPy = "python"
}
Write-Host "[setup] 安装 Python 依赖（requirements.txt）..."
& $VenvPy -m pip install -r requirements.txt -q
Write-Host "[setup] Python 依赖 OK"

# ── pnpm install ────────────────────────────────────────────────────
Write-Host "[setup] pnpm install..."
pnpm install
Write-Host "[setup] pnpm install OK"

# ── llama.cpp（预编译 CPU x64，同 Linux 代理链）───────────────────
if (-not $SkipLlama.IsPresent) {
    Write-Host "[setup] 准备 llama.cpp（Windows 预编译 CPU 版）..."
    New-Item -ItemType Directory -Force (Join-Path $Root 'llama.cpp\build\bin') | Out-Null
    $LLAMA_BIN = Join-Path $Root 'llama.cpp\build\bin\llama-server.exe'
    if (Test-Path $LLAMA_BIN) {
        Write-Host "[setup] 已存在 $LLAMA_BIN，跳过"
    } else {
        $DL_OK = $false
        if (Test-Exe curl) {
            Write-Host "[setup] 尝试下载 llama.cpp 预编译二进制..."
            $GH_BASE = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
            $GH_PREFIX = ""
            $LATEST = curl.exe -fsSL --max-time 30 "$GH_BASE" 2>$null
            if (-not $LATEST) {
                foreach ($proxy in @("https://ghfast.top/", "https://gh-proxy.com/", "https://ghproxy.net/")) {
                    $LATEST = curl.exe -fsSL --max-time 30 "$proxy$GH_BASE" 2>$null
                    if ($LATEST) { $GH_PREFIX = $proxy; break }
                }
            }
            if ($LATEST) {
                $ASSET = & py -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
    for a in d.get('assets', []):
        if 'bin-win-cpu-x64.zip' in a.get('name', ''):
            print(a['browser_download_url'])
            sys.exit(0)
except Exception: pass
sys.exit(1)
" $LATEST 2>$null
                if ($ASSET) {
                    $TMPZIP = Join-Path $env:TEMP "llama.zip"
                    $URL = if ($GH_PREFIX) { "$GH_PREFIX$ASSET" } else { $ASSET }
                    if (curl.exe -fSL --max-time 300 -o $TMPZIP "$URL" 2>$null) {
                        Expand-Archive -Path $TMPZIP -DestinationPath (Join-Path $Root 'llama.cpp\build\bin') -Force
                        Remove-Item $TMPZIP -Force -ErrorAction SilentlyContinue
                        if (Test-Path $LLAMA_BIN) { $DL_OK = $true }
                    }
                }
            }
        }
        if (-not $DL_OK) {
            Write-Warning "[setup] 预编译下载失败。请手动下载 bin-win-cpu-x64.zip 并解压到 $Root\llama.cpp\build\bin\"
        }
    }
}

# ── 配置生成 ────────────────────────────────────────────────────────
Write-Host "[setup] 生成 slime.toml..."
& 'powershell' -File (Join-Path $ScriptDir 'gen-config.ps1') --root $Root --force

# ── 模型下载（可选）─────────────────────────────────────────────────
if ($WithModels.IsPresent) {
    Write-Host "[setup] 下载模型..."
    & 'powershell' -File (Join-Path $ScriptDir 'fetch-models.ps1')
}

# ── 收尾 ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================================"
Write-Host "  环境就绪"
Write-Host ""
Write-Host "  启动："
Write-Host "    pwsh windows\run-server.ps1    # 后端（终端 1）"
Write-Host "    pwsh windows\run-cli.ps1       # CLI（终端 2）"
Write-Host ""
Write-Host "  新用户一步到位："
Write-Host "    pwsh windows\setup.ps1 --WithModels"
Write-Host ""
Write-Host "  模型目录（请把 GGUF 放入）："
Write-Host "    $Root\models\BGE-M3\bge-m3-q8_0.gguf   （嵌入，必需）"
Write-Host "    $Root\models\chat\*.gguf               （对话）"
Write-Host "================================================================"
