# -*- coding: utf-8 -*-
"""新兑底 sidecar（sidecar/silam_brain_sidecar.py）JSONL 契约冒烟：
status/reply/observe/自动触痛/inference/save/heal 全链路（对齐 core-ts 协议）。
"""
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "sidecar" / "silam_brain_sidecar.py"

PASS = 0


def check(name, cond, detail=""):
    global PASS
    print(f"  {'✓' if cond else '✗'} {name}" + (f" —— {detail}" if detail else ""))
    if cond:
        PASS += 1


def main():
    assert SCRIPT.exists(), f"sidecar 缺失: {SCRIPT}"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
    proc = subprocess.Popen(["py", str(SCRIPT), "--agent-id", "smoke-new"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=str(REPO), env=env)

    def send(req):
        rid = uuid.uuid4().hex[:8]
        req = {"request_id": rid, **req}
        proc.stdin.write(json.dumps(req, ensure_ascii=False).encode() + b"\n")
        proc.stdin.flush()
        while True:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("sidecar 提前退出: " + proc.stderr.read().decode()[-800:])
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg["request_id"] == rid:
                return msg

    try:
        st = send({"type": "status"})
        ok_st = st["status"] == "success"
        check("status 握手+语言脑挂载",
              ok_st and st["payload"].get("lang_loaded") is True
              and st["payload"].get("lang_vocab", 0) >= 6900,
              f"lang_vocab={st['payload'].get('lang_vocab')}")
        check("status 情感脑 n_nodes/status_line",
              st["payload"].get("n_nodes") is not None)

        rp = send({"type": "reply", "payload": {
            "agent_name": "SILAM", "agent_role": "自主生命模型",
            "user_message": "磁盘快满了，数据要丢了，我好担心", "history": []}})
        ok_rp = rp["status"] == "success"
        body = rp["payload"].get("reply") or ""
        check("reply 兑底成功且有语言脑正文",
              ok_rp and "我是 SILAM" in body and len(body) > 20,
              body[:70].replace("\n", " | "))
        check("reply 思考区分层", bool(rp["payload"].get("reasoning")),
              (rp["payload"].get("reasoning") or "")[:50].replace("\n", " | "))

        ob = send({"type": "observe", "payload": {
            "user_message": "磁盘清理最佳实践", "reply": "先归档再删"}})
        check("observe 观摩入库", ob["status"] == "success"
              and ob["payload"].get("observed") is True)

        rp2 = send({"type": "reply", "payload": {
            "agent_name": "SILAM", "agent_role": "自主生命模型",
            "user_message": "又把日志写坏了",
            "history": [{"role": "user", "content": "清理日志文件", "tool_error": True}]}})
        dmg = (rp2["payload"].get("damaged") or 0)
        check("兑底自动触痛(damaged≥1)", rp2["status"] == "success" and dmg >= 1,
              f"damaged={dmg}")

        inf = send({"type": "inference", "payload": {
            "state_text": "目标：系统崩溃恢复", "fear_level": 0.8}})
        check("inference 兑底兼容 + novelty 字段",
              inf["status"] == "success" and "novelty" in inf["payload"],
              f"novelty={inf['payload'].get('novelty')}")

        sv = send({"type": "save"})
        check("save 持久化", sv["status"] == "success")
        hl = send({"type": "heal", "payload": {"severity": 0.8, "context": "磁盘操作失误"}})
        check("heal 损伤冻结", hl["status"] == "success" and "damaged" in hl["payload"])
    finally:
        proc.stdin.close()
        proc.wait(timeout=15)

    print(f"\n== 兑底 sidecar JSONL 契约：通过 {PASS}/9 ==")
    return 0 if PASS == 9 else 1


if __name__ == "__main__":
    raise SystemExit(main())