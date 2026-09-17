"""SILAM-Σ 兑底 sidecar（JSON over stdin/stdout，核心-ts GUI 兑底契约）。
   —— 2026-09 换代版：情感脑(80M) + 语言脑(v3.1 d16/6921) 一体；
      资产统一从 <仓库>/models/ 与 <仓库>/_model_stage/data/ 解析，与 CWD 无关。

协议（与 core-ts/src/services/silam_brain.ts 对齐）：
  请求: {"request_id":"uuid","type":"status|reply|observe|inference|save|heal|split","payload":{}}
  响应: {"request_id":"uuid","status":"success|error","payload":{...}}

情感脑：_model_stage/silam_core + data/backbone_80m.npz（80M）
语言脑：resolve_lang_paths → models/对话脑-v3.1L-6921词表/lang_core_d16.npz（d16/6922）
回复 = 情感脑决策(fear/action/novelty) → 语言脑生成正文；垃圾产物回退规则文本。
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

import numpy as np

# 包根锚点（仓库根）：一切资产相对此解析
_REPO = Path(__file__).resolve().parent.parent
if str(_REPO / "_model_stage") not in sys.path:
    sys.path.insert(0, str(_REPO / "_model_stage"))
if str(_REPO / "_model_stage" / "tools") not in sys.path:
    sys.path.insert(0, str(_REPO / "_model_stage" / "tools"))

from silam_core.engine import SILAMEngine  # noqa: E402
from silam_core.config import SilamConfig  # noqa: E402
from silam_core.pretrained import load_pretrained  # noqa: E402
from lang_core import (ACTION_CODES, LangConfig, LanguageCore,  # noqa: E402
                       resolve_lang_paths, Vocab)


def _cfg_to_dict(cfg) -> dict:
    if is_dataclass(cfg):
        return {k: _cfg_to_dict(v) for k, v in asdict(cfg).items()}
    return cfg


def _auto_discover_backbone() -> str | None:
    """情感脑权重发现：models 归档优先，_model_stage/data 工作区兜底。"""
    for cand in (Path(__file__).resolve().parent.parent / "models" /
                 "情感脑-silam-sigma-80m" / "backbone_80m.npz",
                 Path(__file__).resolve().parent.parent / "_model_stage" /
                 "data" / "backbone_80m.npz"):
        if cand.exists():
            return str(cand)
    return None


def _respond(out, rid: str, status: str, payload: dict | None = None,
             error: str | None = None) -> None:
    msg: dict[str, Any] = {"request_id": rid, "status": status,
                           "payload": payload or {}}
    if error:
        msg["error"] = error
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _degenerate(text: str) -> bool:
    """碎片拒绝阀：过短/含unk/单字跑火车/符号过密 → 弃用回退模板。"""
    t = (text or "").strip()
    if len(t) < 4 or "<unk>" in t:
        return True
    prev, run, best = "", 0, 1
    for ch in t:
        run = run + 1 if ch == prev else 1
        best = max(best, run)
        prev = ch
    if best >= 5:
        return True
    if sum(1 for ch in t if ch.isalnum()) / max(len(t), 1) < 0.5:
        return True
    return False


class EngineManager:
    def __init__(self, agent_id: str, cfg: SilamConfig | None = None,
                 backbone_path: str | None = None,
                 brain_dir: Path | None = None) -> None:
        self.agent_id = agent_id
        self.cfg = cfg or SilamConfig()
        self.engine = SILAMEngine(cfg=self.cfg)
        if backbone_path and Path(backbone_path).exists():
            st = load_pretrained(self.engine, backbone_path)
            print(f"[silam] 已装载情感脑 {backbone_path} "
                  f"(loaded={len(st['loaded'])})", file=sys.stderr, flush=True)
        else:
            print("[silam] 情感脑权重缺失，随机初始脑", file=sys.stderr, flush=True)
        self.brain_dir = (brain_dir or
                          Path.home() / ".slimeagent" / agent_id / "brain")
        self.brain_dir.mkdir(parents=True, exist_ok=True)
        # A-961：成长脑接续——先载出厂/初版 backbone，再从 brain 快照恢复成长状态（跨会话成长）
        self._since_save = 0
        self._load_brain()
        # 语言脑（对话脑 v3.1 d16/6921）+ 词表
        self.lang_core = None
        self.lang_vocab = None
        self._load_lang(brain=False)

    def _load_brain(self) -> bool:
        """启动时从 brain.json.npz 恢复成长状态（dendrites/encoder/backbone/step）"""
        f = self.brain_dir / "brain.json.npz"
        if not f.exists():
            return False
        try:
            with np.load(f, allow_pickle=True) as d:
                self.engine.load_state_dict({k: d[k] for k in d.files})
            print(f"[silam] 已载入成长脑 {f} (step={self.engine.step_count})",
                  file=sys.stderr, flush=True)
            return True
        except Exception as e:  # noqa: BLE001
            print(f"[silam] 成长脑载入失败（回到出厂）：{e}",
                  file=sys.stderr, flush=True)
            return False

    def _maybe_autosave(self) -> bool:
        """A-961 节流落盘：observe 累计满 8 次自动 save 一次，防高频写盘"""
        self._since_save += 1
        if self._since_save >= 8 and self.engine.step_count % 8 == 0:
            self._since_save = 0
            self.save()
            return True
        return False

    # ------------------------------------------------------------------
    def _load_lang(self, brain: bool = True) -> None:
        """装载语言脑（canonical：models d16/6922），失败 → None（规则文本兜底）。"""
        try:
            npz_path, vocab_path = resolve_lang_paths(repo_root=_REPO)
            if not npz_path or not vocab_path:
                print("[silam] 语言脑资产缺失 → 兑底仅规则文本", file=sys.stderr, flush=True)
                return
            vocab = Vocab.from_dict(json.load(open(vocab_path, encoding="utf-8")))
            lc = LanguageCore(LangConfig(vocab_size=vocab.size, d_cond=16))
            lc.load_weights(npz_path, vocab.size)
            self.lang_core, self.lang_vocab = lc, vocab
            print(f"[silam] 语言脑挂载: {Path(npz_path).name} "
                  f"词表 {vocab.size} d_cond 16", file=sys.stderr, flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[silam] 语言脑装载失败，回退规则文本: {exc}",
                  file=sys.stderr, flush=True)
            self.lang_core, self.lang_vocab = None, None

    # ------------------------------------------------------------------
    def _lang_reply(self, state_text: str, user_message: str,
                    fear: float, action: str, novelty: float) -> str:
        if self.lang_core is None or self.lang_vocab is None:
            return ""
        try:
            out = self.lang_core.generate(
                state_text or user_message, self.lang_vocab, ACTION_CODES,
                fear=fear, action=action, novelty=novelty,
                max_len=128, temperature=0.7)
            return "" if _degenerate(out) else out
        except Exception:  # noqa: BLE001
            return ""

    # ------------------------------------------------------------------
    def forward(self, payload: dict) -> dict:
        r = self.engine.forward(
            str(payload.get("state_text", "")),
            fear_level=payload.get("fear_level"),
            desire_level=payload.get("desire_level"),
            latency_ratio=float(payload.get("latency_ratio", 0.0)))
        return {
            "tool_call": r.tool_call, "thought_vector": r.thought_vector,
            "new_fear": r.new_fear, "new_desire": r.new_desire,
            "novelty": getattr(r, "novelty", 0.5),
            "activated_nodes": r.activated_nodes, "grew_node_idx": r.grew_node_idx,
            "n_nodes": r.n_nodes, "max_nodes": r.max_nodes, "step": r.step,
            "damaged": int(self.engine.dendrites.damaged_flags.sum()),
            "avoidance": bool((r.events or {}).get("avoidance")),
        }

    def reply(self, payload: dict) -> dict:
        """兑底：情感脑决策 + 语言脑生成正文；失败回退规则文本。"""
        from silam_core.reply import compose_parts  # noqa: E402
        agent_name = str(payload.get("agent_name") or "SILAM")
        agent_role = str(payload.get("agent_role") or "AI 助手")
        user_message = str(payload.get("user_message") or "")
        history = payload.get("history") or []

        state_parts = [f"[{agent_role}]"]
        for msg in list(history)[-4:]:
            role = str(msg.get("role", "")); content = str(msg.get("content", ""))[:50]
            if role == "user":
                state_parts.append(f"用户:{content}")
            elif role == "assistant":
                state_parts.append(f"助手:{content}")
        state_parts.append(f"当前:{user_message[:80]}")
        # A-963 双向桥-前向：slime 侧为该 Agent 沉淀的长期记忆（Knowledge/Agent Memory/<agent>）
        # 注入 state_text —— 同时进入情感脑 forward 决策与语言脑 lang_reply 的上下文
        slime_memory = payload.get("slime_memory") or []
        if slime_memory:
            state_parts.append("(slime 长期记忆)")
            for txt in list(slime_memory)[:6]:
                t = str(txt).strip()[:120]
                if t:
                    state_parts.append(f"记忆:{t}")
        state_text = " | ".join(state_parts)

        errors = sum(1 for m in list(history)[-5:] if m.get("tool_error"))
        fear = min(1.0, 0.3 + errors * 0.2) if errors else 0.3
        r = self.engine.forward(state_text, fear_level=fear, desire_level=0.5)

        # 自动触痛（工具失败历史 → 冻结最近记忆）
        if errors:
            try:
                ctx = next((str(m.get("content", ""))[:80]
                            for m in list(history)[-5:] if m.get("tool_error")),
                           "工具调用失败")
                self.engine.injure_soft(severity=min(0.35 + 0.15 * errors, 0.8),
                                        context_text=f"历史工具失败：{ctx}")
            except Exception:  # noqa: BLE001
                pass

        recalled: list[str] = []
        if getattr(self.engine, "_mem_texts", None):
            try:
                recalled = self.engine._mem_recall(1, user_message)
            except Exception:  # noqa: BLE001
                recalled = []

        content_lines, reasoning_lines = compose_parts(
            agent_name=agent_name, agent_role=agent_role,
            user_message=user_message, report=r, recalled=recalled,
            capability_text=None, offline_note="（离线应答 · SILAM 大脑)")

        # 语言脑正文（身份铁律前缀 + 可复现 seed）
        lang_out = self._lang_reply(state_text, user_message, float(r.new_fear),
                                    str(getattr(r.tool_call, "get", lambda k, d=None: d)("tool", "memory_store")),
                                    float(getattr(r, "novelty", 0.5)))
        reply = "\n".join(content_lines)
        if lang_out:
            reply = f"我是 {agent_name}，{agent_role}。\n{lang_out}"
        reasoning = "\n".join(reasoning_lines) or None
        return {"reply": reply, "reasoning": reasoning,
                "damaged": int(self.engine.dendrites.damaged_flags.sum()),
                "fear": float(self.engine.affect_state.fear_total)}

    def observe(self, payload: dict) -> dict:
        from silam_core.explorer import Explorer  # noqa: E402
        user_message = str(payload.get("user_message") or "")
        reply = str(payload.get("reply") or "")
        if not user_message or not reply.strip():
            return {"observed": False, "reason": "empty"}
        try:
            exp = Explorer(silam_engine=self.engine, search_callback=lambda q: "")
            exp._running = True  # noqa: SLF001 同步兑底，不起后台循环
            exp.observe_interaction(user_message, reply, success=True)
            self._maybe_autosave()  # A-961：节流自动落盘成长
            return {"observed": True, "mem": len(self.engine._mem_texts),
                    "nodes": self.engine.dendrites.n}
        except Exception as e:  # noqa: BLE001
            return {"observed": False, "error": str(e)}

    def save(self) -> dict:
        sd = self.engine.state_dict()
        np.savez_compressed(self.brain_dir / "brain.json.npz", **sd)
        np.save(self.brain_dir / "keys.npy", sd["dendrites"]["keys"])
        np.save(self.brain_dir / "values.npy", sd["dendrites"]["values"])
        np.save(self.brain_dir / "fears.npy", sd["dendrites"]["fears"])
        np.save(self.brain_dir / "forgotten_buffer.npy",
                sd["dendrites"]["forgotten_keys"])
        (self.brain_dir / "meta.json").write_text(
            json.dumps({"agent_id": self.agent_id,
                        "step_count": self.engine.step_count,
                        "forgotten_count": sd["forgotten_count"],
                        "cfg": _cfg_to_dict(self.cfg)},
                       ensure_ascii=False, indent=2))
        return {"saved_step": self.engine.step_count,
                "n_nodes": self.engine.dendrites.n}

    def status(self) -> dict:
        return {"agent_id": self.agent_id, "step": self.engine.step_count,
                "n_nodes": self.engine.dendrites.n,
                "damaged": int(self.engine.dendrites.damaged_flags.sum()),
                "fear": self.engine.affect_state.fear_total,
                "desire": self.engine.affect_state.desire,
                "lang_loaded": self.lang_core is not None,
                "lang_vocab": self.lang_vocab.size if self.lang_vocab else 0,
                "status_line": self.engine.status_line()}

    def heal(self, payload: dict) -> dict:
        pain = self.engine.injure_soft(
            severity=float(payload.get("severity", 0.8)),
            context_text=str(payload.get("context", "")))
        return {"pain": pain,
                "damaged": int(self.engine.dendrites.damaged_flags.sum())}


def main() -> int:
    ap = argparse.ArgumentParser(description="SILAM-Σ 兑底 sidecar（JSONL）")
    ap.add_argument("--agent-id", required=True)
    ap.add_argument("--backbone", default=None)
    ap.add_argument("--brain-dir", default=None)
    ap.add_argument("--cfg", default=None)
    args = ap.parse_args()

    backbone = args.backbone or _auto_discover_backbone()
    cfg = SilamConfig.from_toml(args.cfg) if args.cfg else SilamConfig()
    mgr = EngineManager(agent_id=args.agent_id, cfg=cfg,
                        backbone_path=backbone,
                        brain_dir=Path(args.brain_dir) if args.brain_dir else None)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            _respond(sys.stdout, "", "error", error=f"JSON 解析失败: {e}")
            continue
        rid = str(req.get("request_id", uuid.uuid4().hex[:8]))
        t = str(req.get("type", "")).strip().lower()
        p = req.get("payload", {}) or {}
        try:
            if t == "reply":
                _respond(sys.stdout, rid, "success", mgr.reply(p))
            elif t == "inference":
                _respond(sys.stdout, rid, "success", mgr.forward(p))
            elif t == "status":
                _respond(sys.stdout, rid, "success", mgr.status())
            elif t == "observe":
                _respond(sys.stdout, rid, "success", mgr.observe(p))
            elif t == "save":
                _respond(sys.stdout, rid, "success", mgr.save())
            elif t == "heal":
                _respond(sys.stdout, rid, "success", mgr.heal(p))
            elif t == "split":
                _respond(sys.stdout, rid, "success", {"note": "split 待 4D"})
            else:
                _respond(sys.stdout, rid, "error", error=f"未知 type: {t}")
        except Exception as e:  # noqa: BLE001
            import traceback
            _respond(sys.stdout, rid, "error",
                     error=f"{type(e).__name__}: {e}\n{traceback.format_exc()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())