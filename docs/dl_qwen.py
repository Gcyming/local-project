# -*- coding: utf-8 -*-
"""下载 Qwen2.5-3B-Instruct Q8_0 GGUF（走 ModelScope，带断点续传）"""
import urllib.request
import os

URL = 'https://modelscope.cn/models/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/master/qwen2.5-3b-instruct-q8_0.gguf'
OUT = r'D:\tool\slime\Local model\qwen2.5-3b-instruct-q8_0.gguf'
TMP = OUT + '.part'
TARGET_SIZE = 3616088480

# 若正式文件已有一部分但未完成，将其作为断点继续
if os.path.exists(OUT) and os.path.getsize(OUT) < TARGET_SIZE and not os.path.exists(TMP):
    os.rename(OUT, TMP)

have = os.path.getsize(TMP) if os.path.exists(TMP) else 0
headers = {'User-Agent': 'Mozilla/5.0'}
if have:
    headers['Range'] = 'bytes={}-'.format(have)

req = urllib.request.Request(URL, headers=headers)
resp = urllib.request.urlopen(req, timeout=120)
total = int(resp.headers.get('Content-Length')) + have
print('断点位置: {:.2f} GB, 目标总量: {:.2f} GB'.format(have / 1e9, total / 1e9))

with open(TMP, 'ab' if have else 'wb') as f:
    done = have
    while True:
        chunk = resp.read(1048576)
        if not chunk:
            break
        f.write(chunk)
        done += len(chunk)
        print('\r{:.2f} / {:.2f} GB ({:.1f}%)'.format(done / 1e9, total / 1e9, done * 100 / total),
              end='', flush=True)

os.replace(TMP, OUT)
real = os.path.getsize(OUT)
print('\n=== 下载完成: {} ({} bytes)'.format(OUT, real))
print('=== 校验:', '通过，大小与官方一致' if real == TARGET_SIZE else '警告！大小不一致，期望 {}'.format(TARGET_SIZE))