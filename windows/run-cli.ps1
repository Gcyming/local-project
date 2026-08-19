#!/usr/bin/env pwsh
# 快速 CLI 启动入口（等价于 linux/run-cli.sh）
$Kit = Split-Path $MyInvocation.MyCommand.Path -Parent
$Kit = Split-Path $Kit -Parent
Set-Location $Kit
& py slime_cli.py $args
