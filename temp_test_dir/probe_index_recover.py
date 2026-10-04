"""尝试无损还原 gui/src/main/index.ts 的 GBK 乱码，并判断原有内容是否可恢复。

乱码成因（已确认）：文件原本是 **无 BOM 的 UTF-8**，PowerShell `Get-Content -Raw`
按系统 ANSI(GBK/CP936) 读取 → 得到乱码字符串 → `Set-Content -Encoding utf8` 写成
「BOM + 乱码」。GBK 解码对不合法字节对会用 '?' 顶替，**那部分是不可逆的信息丢失**。

本脚本：
 1. 反向变换（乱码字符串 → GBK 字节 → UTF-8）尝试还原
 2. 统计不可逆位置（'?' 顶替）
 3. 把还原结果与 HEAD 比对，判断「除我预期的 5 处类型改动外是否还有别的差异」
只读，不写任何文件。
"""
import difflib
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REL = "gui/src/main/index.ts"
PATH = ROOT / REL

cur = PATH.read_text(encoding="utf-8-sig")

head_raw = subprocess.run(
    ["git", "-C", str(ROOT), "show", f"HEAD:{REL}"],
    capture_output=True, check=True,
).stdout.decode("utf-8-sig")
head = head_raw.replace("\r\n", "\n").replace("\r", "\n")

# ── 反向变换 ──
lossy = cur.count("?")
try:
    recovered_bytes = cur.encode("gbk", errors="replace")
    rec = recovered_bytes.decode("utf-8", errors="replace")
    enc_fail = cur.encode("gbk", errors="replace").decode("gbk", errors="replace") != cur
except Exception as e:  # noqa: BLE001
    rec = ""
    print(f"GBK 反编码失败: {e}")

rec = rec.replace("\r\n", "\n").replace("\r", "\n")

print("=== 反向变换结果 ===")
print(f"当前(乱码) 长度: {len(cur):>8}")
print(f"还原后     长度: {len(rec):>8}")
print(f"HEAD       长度: {len(head):>8}")
print(f"'?' 顶替字符数（不可逆丢失）: {lossy}")
print()

if rec:
    print("=== 还原结果 vs HEAD ===")
    print(f"完全一致: {rec == head}")
    h = head.split("\n")
    r = rec.split("\n")
    if rec != head:
        sm = difflib.SequenceMatcher(None, h, r, autojunk=False)
        ops = [o for o in sm.get_opcodes() if o[0] != "equal"]
        dels = sum(o[2] - o[1] for o in ops)
        inss = sum(o[4] - o[3] for o in ops)
        print(f"差异块 {len(ops)} 个 / 删除行 {dels} / 新增行 {inss}")
        print()
        print("--- 差异明细（前 20 块）---")
        for tag, i1, i2, j1, j2 in ops[:20]:
            print(f"[{tag}] HEAD[{i1+1}:{i2}] -> REC[{j1+1}:{j2}]")
            for ln in h[i1:min(i2, i1 + 2)]:
                print(f"   - {ln[:130]}")
            for ln in r[j1:min(j2, j1 + 2)]:
                print(f"   + {ln[:130]}")
            print()

    # 单独确认我那 5 处类型改动是否已在还原结果里
    marker_old = '{ mode: "default" | "custom"; skills: string[]; mcp: string[] }'
    marker_new = '{ mode: "default" | "creator" | "custom"; skills: string[]; mcp: string[] }'
    print("=== 我的 5 处替换在还原结果中的状态 ===")
    print(f"旧类型串出现次数: {rec.count(marker_old)}")
    print(f"新类型串出现次数: {rec.count(marker_new)}")
    print(f"HEAD 里旧类型串次数: {head.count(marker_old)}")
