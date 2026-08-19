#!/usr/bin/env pwsh
# 快速后端启动入口（等价于 linux/run-server.sh）
$Kit = Split-Path $MyInvocation.MyCommand.Path -Parent
$Kit = Split-Path $Kit -Parent
Set-Location $Kit
& py slime_server.py $args
