# -*- coding: utf-8 -*-
"""下载 llama.cpp CUDA 预编译包（GitHub Release，带断点续传）"""
import urllib.request
import os

URL = 'https://github.com/ggml-org/llama.cpp/releases/download/b10362/cudart-llama-bin-win-cuda-12.4-x64.zip'
OUT = r'D:\tool\slime\llama-cpp-cuda-12.4.zip'
TMP = OUT + '.part'

have = os.path.getsize(TMP) if os.path.exists(TMP) else 0
headers = {'User-Agent': 'Mozilla/5.0'}
if have:
    headers['Range'] = 'bytes={}-'.format(have)

req = urllib.request.Request(URL, headers=headers)
resp = urllib.request.urlopen(req, timeout=120)
total = int(resp.headers.get('Content-Length')) + have
print('断点位置: {} bytes, 目标总量: {} bytes'.format(have, total))

with open(TMP, 'ab' if have else 'wb') as f:
    done = have
    while True:
        chunk = resp.read(1048576)
        if not chunk:
            break
        f.write(chunk)
        done += len(chunk)
        print('\r{:.1f} / {:.1f} MB ({:.1f}%)'.format(done / 1e6, total / 1e6, done * 100 / total),
              end='', flush=True)

os.replace(TMP, OUT)
real = os.path.getsize(OUT)
print('\n=== 下载完成: {} ({} bytes)'.format(OUT, real))