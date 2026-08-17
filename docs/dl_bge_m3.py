# -*- coding: utf-8 -*-
"""下载 BGE-M3 Q8_0 GGUF（走 hf-mirror 镜像，带断点续传）"""
import urllib.request
import os

URL = 'https://hf-mirror.com/ggml-org/bge-m3-Q8_0-GGUF/resolve/main/bge-m3-q8_0.gguf'
OUT = r'D:\tool\slime\BGE-M3\bge-m3-q8_0.gguf'
TMP = OUT + '.part'
TARGET_SIZE = 634553760

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
print('=== 校验:', '通过，大小与官方一致' if real == TARGET_SIZE else '警告！大小不一致，期望 {}'.format(TARGET_SIZE))
