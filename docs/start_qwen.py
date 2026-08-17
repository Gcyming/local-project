# -*- coding: utf-8 -*-
"""启动 Qwen2.5-3B-Instruct 对话服务（纯 Python，无转义问题）"""
import subprocess
import time
import os

EXE = r'D:\tool\slime\llama.cpp\llama-server.exe'
MODEL = r'D:\tool\slime\Local model\qwen2.5-3b-instruct-q8_0.gguf'
LOG = r'D:\tool\slime\qwen-server.err.log'
OUT = r'D:\tool\slime\qwen-server.log'

# 1. 清理可能残留的服务进程
subprocess.run(['taskkill', '/F', '/IM', 'llama-server.exe'],
               capture_output=True, text=True)
time.sleep(2)

# 2. 清理旧日志
for f in [LOG, OUT]:
    if os.path.exists(f):
        os.remove(f)

# 3. 启动服务（参数直接作为列表传递，空格/特殊字符零转义）
args = [EXE, '-m', MODEL, '--port', '8998', '--n-gpu-layers', '99',
        '--host', '127.0.0.1', '--ctx-size', '4096']
proc = subprocess.Popen(args, stdout=open(OUT, 'w'), stderr=open(LOG, 'w'))
time.sleep(15)

print('服务进程 PID:', proc.pid)
print('--- 服务日志（末尾10行）---')
with open(LOG, encoding='utf-8', errors='replace') as f:
    lines = f.readlines()
print(''.join(lines[-10:]))