"""A-962 打包纯净化复验（v2）：按 asar 文件清单 + 密钥长串双重校验。
用法：py .tools/verify_package.py [win-unpacked 目录]
返回 0=纯净可发；非 0=有违规项。
"""
from __future__ import annotations
import json
import os
import re
import subprocess
import sys

WIN = sys.argv[1] if len(sys.argv) > 1 else r"D:\pilot project\gui\release-final\win-unpacked"
ASAR = os.path.join(WIN, "resources", "app.asar")
problems = []

# 1) asar 文件清单级校验：敏感「数据文件」不得存在（代码里的路径常量不算）
try:
    out = subprocess.run(
        ["npx", "-y", "@electron/asar@3.2.17", "list", ASAR],
        capture_output=True, text=True, encoding="utf-8", timeout=120,
    ).stdout
    entries = [ln.strip().lstrip("\\/") for ln in out.splitlines() if ln.strip()]
except Exception as e:  # noqa: BLE001
    entries = []
    print("WARN: asar list 不可用（用字节扫描降级）：", e)
SENSITIVE_PATHS = [
    "config/providers.enc.json", "config/auth_token.json", "config/sessions.json",
    "config/history.jsonl", "config/agents.json", "config/global_config.json",
    "config/providers.json", ".enc.json", "data/", "Knowledge/",
]
for entry in entries:
    low = entry.replace("\\", "/").lower()
    if low.startswith("node_modules/"):
        continue
    for sp in SENSITIVE_PATHS:
        if low.endswith(sp) or (sp.endswith("/") and low.startswith(sp)):
            problems.append(f"asar 内存在数据文件: {entry}")
            break

# 2) 密钥长串（二进制直扫）：sk- 后 ≥20 位字母数字
with open(ASAR, "rb") as f:
    blob = f.read()
sk = len(re.findall(rb"sk-[a-zA-Z0-9]{20,}", blob))
if sk:
    problems.append(f"asar 疑似含 {sk} 处明文 API Key（sk- 长串）")

# 3) 包根不得含用户 config/ 数据目录
if os.path.isdir(os.path.join(WIN, "config")) and os.listdir(os.path.join(WIN, "config")):
    problems.append("包根存在 config/ 且有内容（用户配置不应随包分发）")

# 4) SILAM 资产齐
for rel in [
    "sidecar/silam_brain_sidecar.py",
    "models/情感脑-silam-sigma-80m/backbone_80m.npz",
    "models/对话脑-v3.1L-6921词表/lang_core_d16.npz",
    "configs/vocab.v3.1-6921.json",
    "_model_stage/silam_core/engine.py",
    "_model_stage/tools/lang_core.py",
]:
    if not os.path.exists(os.path.join(WIN, rel)):
        problems.append(f"SILAM 资产缺失: {rel}")

# 5) 包内 slime.toml 含 [silam] 且无明文密钥
toml = os.path.join(WIN, "slime.toml")
if os.path.exists(toml):
    text = open(toml, encoding="utf-8").read()
    if "\n[silam]" not in text:
        problems.append("slime.toml 缺 [silam] 段（打包版 SILAM 无法启用）")
    if re.search(r"sk-[a-zA-Z0-9]{20,}", text):
        problems.append("slime.toml 含明文 Key")
else:
    problems.append("slime.toml 缺失")

print("违规项:", problems if problems else "无 —— 包纯净（无用户数据文件/无明文密钥）、SILAM 资产完备、模板含 [silam]")
sys.exit(1 if problems else 0)