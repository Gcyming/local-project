"""
slime Swarm 三闸中的「花费闸」与「墙钟闸」（docs/slime-agent-loop-design.md §1.2）

轮次闸（`MAX_ROUNDS`）仍留在 core/executor.py 与 core/process_worker.py，**语义不动**：
轮次耗尽未收到 `<DONE>` 一律 failed。本模块只做加法：
    阈值解析 → token 折算金额 → 墙钟计时 → 触发时给出**可归因**的终止理由（显式终止）。
三闸一致性由调用方保证（executor / process_worker 在每个轮次边界调用 `check()`）。

⚠️ 定价数据：Python 侧**没有自己的价目表**（价目表在 shared/ 与 core-ts/ 侧）。
本模块按「读得到才算」取价，四级全部读不到 → 花费闸**禁用并告警**，绝不凭空编价：

    1. slime.toml `[swarm_gates].pricing_file` 指向的 JSON 表（用户自定义，最高优先）
    2. provider 配置的存值价 `price_in_usd` / `price_out_usd`
       （= providers.enc.json 里 GUI 供应商面板写入的存值价，USD / 1M tokens）
    3. 项目根 `config/pricing.json`（若存在，schema 同 1）
    4. `shared/gen/pricing-snapshot.ts`（仓库内自动生成的价格快照，**只读**解析；
       社区镜像口径 = LiteLLM 刊例价 / OpenRouter 路由价，快照 id 已规范化）

语义与本仓库记账口径一致（core-ts `computeRecordCost`）：USD / 1M tokens；
`0` = **免费**（有效价，必须原样保留），字段缺失 = **未定价**（不可当 0 用）。
本闸算出的金额是**闸门用的折算值**，权威账目在 core-ts 的 `config/usage.jsonl`，两者不互相替代。

token 计数：优先用上游回传的真实 usage（`core/llm.call_api_provider` 的 `usage_sink`）；
工具轮 / 上游不回传时回退本地估算（口径 = core/llm._estimate_tokens）——归因文案会
标注「token 数为本地估算」，不把估算冒充实测。
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_TOML_PATH = _PROJECT_ROOT / "slime.toml"
_SNAPSHOT_PATH = _PROJECT_ROOT / "shared" / "gen" / "pricing-snapshot.ts"
_PRICING_JSON_PATH = _PROJECT_ROOT / "config" / "pricing.json"

TOKENS_PER_PRICE_UNIT = 1_000_000

DEFAULT_COST_LIMIT_USD = 1.0
DEFAULT_WALL_CLOCK_SECONDS = 3600.0

GATE_COST = "cost"
GATE_WALL = "wall"

COST_GATE_LABEL = "花费超限终止"
WALL_GATE_LABEL = "墙钟超限终止"


@dataclass
class GateLimits:
    """两个新闸的阈值（来自 slime.toml [swarm_gates]，缺省用本模块默认值）。

    - `enabled=False` 一次性关掉两个新闸（轮次闸不受影响）
    - 单个阈值 <= 0 表示**只关这一闸**（显式配置入口，非隐式魔法）
    """

    enabled: bool = True
    cost_limit_usd: float = DEFAULT_COST_LIMIT_USD
    wall_clock_seconds: float = DEFAULT_WALL_CLOCK_SECONDS
    pricing_file: str = ""

    @property
    def cost_enabled(self) -> bool:
        return bool(self.enabled) and self.cost_limit_usd > 0

    @property
    def wall_enabled(self) -> bool:
        return bool(self.enabled) and self.wall_clock_seconds > 0


def _as_float(value, default: float) -> float:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return default
    return default


def _as_bool(value, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        low = value.strip().lower()
        if low in ("true", "yes", "on", "1"):
            return True
        if low in ("false", "no", "off", "0"):
            return False
    return default


def _read_toml_section(path: Path, section: str) -> dict:
    """读 slime.toml 的某个 section（先 tomllib，Python<3.11 走简易解析）。

    只取本模块关心的段；文件缺失/损坏 → 空 dict（调用方用默认值），不抛异常。
    """
    if not path.exists():
        return {}
    text = ""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        logging.warning(f"[budget] 读取 {path.name} 失败: {e}")
        return {}

    try:
        import tomllib
    except ImportError:
        tomllib = None

    if tomllib is not None:
        try:
            data = tomllib.loads(text)
        except Exception as e:
            logging.warning(f"[budget] 解析 {path.name} 失败: {e}")
        else:
            sec = data.get(section)
            return sec if isinstance(sec, dict) else {}

    result: dict = {}
    current = None
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            current = line.strip("[]").strip()
            continue
        if current != section or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        elif value.lower() in ("true", "false"):
            value = value.lower() == "true"
        else:
            try:
                value = float(value) if ("." in value or "e" in value.lower()) else int(value)
            except ValueError:
                pass
        result[key] = value
    return result


def load_gate_limits(toml_path: Path | str | None = None) -> GateLimits:
    """从 slime.toml [swarm_gates] 读阈值；缺段/缺键/非法值一律回退默认值。"""
    path = Path(toml_path) if toml_path is not None else _TOML_PATH
    sec = _read_toml_section(path, "swarm_gates")
    limits = GateLimits()
    if not sec:
        return limits
    return GateLimits(
        enabled=_as_bool(sec.get("enabled"), limits.enabled),
        cost_limit_usd=_as_float(sec.get("cost_limit_usd"), limits.cost_limit_usd),
        wall_clock_seconds=_as_float(
            sec.get("wall_clock_seconds"), limits.wall_clock_seconds
        ),
        pricing_file=str(sec.get("pricing_file") or "").strip(),
    )


@dataclass(frozen=True)
class PriceInfo:
    """某模型的单价（USD / 1M tokens）与其来源（来源必须随价一起上报，便于追账）。"""

    price_in: float
    price_out: float
    source: str
    detail: str = ""
    tiered: bool = False

    def cost_usd(self, prompt_tokens: int, completion_tokens: int) -> float:
        return (
            max(0, int(prompt_tokens)) * self.price_in
            + max(0, int(completion_tokens)) * self.price_out
        ) / TOKENS_PER_PRICE_UNIT

    def describe(self) -> str:
        text = (
            f"单价 {self.price_in:g}/{self.price_out:g} USD per 1M tokens"
            f"（输入/输出，来源：{self.source}{'·' + self.detail if self.detail else ''}）"
        )
        if self.tiered:
            text += "；该模型长上下文分档计价，本闸按基准价折算（可能低估）"
        return text


_SOURCE_LABELS = {
    "pricing-file": "自定义定价表",
    "provider-stored": "provider 存值价",
    "repo-snapshot": "仓库价格快照（社区镜像口径）",
}


def normalize_model_id(raw: str) -> str:
    """规范化模型 id（对齐 shared/gen/model-capabilities.ts 的 normalizeModelIdForSnapshot）"""
    model_id = (raw or "").strip().lower()
    if model_id.startswith("~"):
        model_id = model_id[1:]
    if "/" in model_id:
        model_id = model_id[model_id.rfind("/") + 1:]
    return model_id


def _match_id(table: dict, model_id: str):
    """在 {规范化 id: 值} 表里查模型：精确命中优先，否则**最长前缀**且必须落在 token 边界。

    对齐 TS `findSnapshotPricing`：`gpt-5` 不该命中 `gpt-50x`，`claude-opus-4-5` 不该吃掉 4-6。
    """
    key = normalize_model_id(model_id)
    if not key or not isinstance(table, dict):
        return None
    if key in table:
        return table[key]
    best_key = ""
    for candidate in table:
        if key.startswith(candidate) and len(candidate) > len(best_key):
            best_key = candidate
    if not best_key:
        return None
    rest = key[len(best_key):]
    if not re.match(r"^[-_.:]", rest):
        return None
    return table[best_key]


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _price_from_provider_cfg(provider_cfg: dict, model_id: str = "") -> PriceInfo | None:
    """provider 配置里的存值价（providers.enc.json 的 price_in_usd / price_out_usd）。

    兼容两种形态：价直接挂在 provider 上，或挂在 `models[]` 里被选中/同 id 的那条模型上。
    两个字段必须**同时**是数字（缺失 = 未定价，不能当 0 用；0 本身是合法免费价）。
    """
    if not isinstance(provider_cfg, dict):
        return None
    want = normalize_model_id(model_id or str(provider_cfg.get("model") or ""))
    candidates = [provider_cfg]
    models = provider_cfg.get("models")
    if isinstance(models, list):
        for entry in models:
            if not isinstance(entry, dict):
                continue
            entry_id = normalize_model_id(str(entry.get("id") or ""))
            if want and entry_id == want:
                candidates.insert(0, entry)
            elif entry.get("selected") is True:
                candidates.append(entry)
    for entry in candidates:
        price_in = entry.get("price_in_usd")
        price_out = entry.get("price_out_usd")
        if _is_number(price_in) and _is_number(price_out):
            detail = normalize_model_id(str(entry.get("id") or "")) or want or "provider 级"
            return PriceInfo(
                price_in=float(price_in),
                price_out=float(price_out),
                source=_SOURCE_LABELS["provider-stored"],
                detail=detail,
            )
    return None


def _table_from_json(path: Path) -> dict:
    """读 JSON 定价表：`{"models": {"<id>": {...}}}` 或直接 `{"<id>": {...}}`。

    单条接受 `price_in_usd`/`price_out_usd`，也接受 `price_in`/`price_out`（同单位）。
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        logging.warning(f"[budget] 读取定价表 {path} 失败: {e}")
        return {}
    if not isinstance(data, dict):
        return {}
    raw_models = data.get("models") if isinstance(data.get("models"), dict) else data
    table = {}
    for key, entry in raw_models.items():
        if not isinstance(entry, dict):
            continue
        price_in = entry.get("price_in_usd", entry.get("price_in"))
        price_out = entry.get("price_out_usd", entry.get("price_out"))
        if not (_is_number(price_in) and _is_number(price_out)):
            continue
        table[normalize_model_id(str(key))] = PriceInfo(
            price_in=float(price_in),
            price_out=float(price_out),
            source=_SOURCE_LABELS["pricing-file"],
            detail=path.name,
            tiered=bool(entry.get("tiered") or entry.get("context_tiers")),
        )
    return table


_SNAPSHOT_LINE_RE = re.compile(r'^\s*\{\s*id:\s*"([^"]+)"(.*)\},?\s*$')
_SNAPSHOT_PRICE_IN_RE = re.compile(r"priceIn:\s*(-?[0-9.eE+]+)")
_SNAPSHOT_PRICE_OUT_RE = re.compile(r"priceOut:\s*(-?[0-9.eE+]+)")

_SNAPSHOT_CACHE: dict = {"key": None, "table": {}}


def _snapshot_table(path: Path | None = None) -> dict:
    """只读解析 shared/gen/pricing-snapshot.ts（生成物，格式：一行一个对象字面量）。

    解析失败/格式变化 → 返回空表（花费闸随之禁用并告警），绝不猜价。
    按 (路径, mtime, size) 缓存，避免每个子任务重解析。
    """
    target = Path(path) if path is not None else _SNAPSHOT_PATH
    try:
        stat = target.stat()
        cache_key = (str(target), stat.st_mtime_ns, stat.st_size)
    except OSError:
        return {}
    if _SNAPSHOT_CACHE["key"] == cache_key:
        return _SNAPSHOT_CACHE["table"]

    table: dict = {}
    try:
        lines = target.read_text(encoding="utf-8").splitlines()
    except OSError as e:
        logging.warning(f"[budget] 读取价格快照 {target} 失败: {e}")
        return {}
    for line in lines:
        head = _SNAPSHOT_LINE_RE.match(line)
        if not head:
            continue
        rest = head.group(2)
        price_in = _SNAPSHOT_PRICE_IN_RE.search(rest)
        price_out = _SNAPSHOT_PRICE_OUT_RE.search(rest)
        if not (price_in and price_out):
            continue
        try:
            price_in_value = float(price_in.group(1))
            price_out_value = float(price_out.group(1))
        except ValueError:
            continue
        table[normalize_model_id(head.group(1))] = PriceInfo(
            price_in=price_in_value,
            price_out=price_out_value,
            source=_SOURCE_LABELS["repo-snapshot"],
            detail=head.group(1),
            tiered="contextTiers" in rest,
        )
    _SNAPSHOT_CACHE["key"] = cache_key
    _SNAPSHOT_CACHE["table"] = table
    return table


def resolve_price(
    model_id: str,
    provider_cfg: dict | None = None,
    limits: GateLimits | None = None,
) -> PriceInfo | None:
    """按 4 级顺序取价；全都读不到 → None（调用方据此**禁用花费闸并告警**）。"""
    limits = limits or GateLimits()

    if limits.pricing_file:
        path = Path(limits.pricing_file)
        if not path.is_absolute():
            path = _PROJECT_ROOT / path
        if path.exists():
            hit = _match_id(_table_from_json(path), model_id)
            if hit is not None:
                return hit
        else:
            logging.warning(f"[budget] 定价表不存在：{path}（回退其它定价来源）")

    hit = _price_from_provider_cfg(provider_cfg or {}, model_id)
    if hit is not None:
        return hit

    if _PRICING_JSON_PATH.exists():
        hit = _match_id(_table_from_json(_PRICING_JSON_PATH), model_id)
        if hit is not None:
            return hit

    return _match_id(_snapshot_table(), model_id)


def _estimate_tokens(text: str) -> int:
    """与 core/llm.py 同口径的粗略估算（缺真实 usage 时的兜底）"""
    try:
        from core.llm import _estimate_tokens as _llm_estimate
        return _llm_estimate(text)
    except Exception:
        return max(1, int(len(text) / 1.5))


@dataclass(frozen=True)
class GateTrip:
    """一次闸门触发（必须能回答「因为哪一闸、到多少了」）"""

    gate: str
    reason: str
    spent_usd: float = 0.0
    elapsed_seconds: float = 0.0
    limit: float = 0.0

    @property
    def is_cost(self) -> bool:
        return self.gate == GATE_COST

    @property
    def is_wall(self) -> bool:
        return self.gate == GATE_WALL


class SubtaskBudget:
    """**单个子任务**的花费闸 + 墙钟闸（轮次闸不在这里，语义不变）。

    用法（调用方负责显式终止）：
        budget = SubtaskBudget(model=..., provider_cfg=cfg); budget.start()
        trip = budget.check()            # 轮次边界：非 None 即终止并归因
        budget.record_round(prompt_tokens=..., completion_tokens=..., ...)
        budget.wall_trip(force=True)     # 被墙钟中断 LLM 调用时取归因
    """

    def __init__(
        self,
        model: str = "",
        provider_cfg: dict | None = None,
        provider_key: str = "",
        name: str = "",
        limits: GateLimits | None = None,
        pricing: PriceInfo | None = None,
        clock: Callable[[], float] | None = None,
    ):
        self.provider_cfg = provider_cfg or {}
        self.provider_key = provider_key
        self.name = name
        self.model = model or str(self.provider_cfg.get("model") or "")
        self.limits = limits or load_gate_limits()
        self._clock = clock or time.monotonic
        self._started_at: float | None = None
        self.rounds = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.estimated = False
        self.pricing = (
            pricing
            if pricing is not None
            else resolve_price(self.model, self.provider_cfg, self.limits)
        )
        self.cost_disabled_reason = ""
        if self.limits.cost_enabled and self.pricing is None:
            self.cost_disabled_reason = (
                f"花费闸已禁用（告警）：模型「{self.model or '未声明'}」读不到定价"
                f"——provider 未存 price_in_usd/price_out_usd、"
                f"config/pricing.json 与仓库价格快照均未命中；不凭空编价，"
                f"仅墙钟闸 + 轮次闸生效"
            )

    def start(self) -> None:
        if self._started_at is None:
            self._started_at = self._clock()

    @property
    def elapsed_seconds(self) -> float:
        if self._started_at is None:
            return 0.0
        return max(0.0, self._clock() - self._started_at)

    @property
    def spent_usd(self) -> float:
        if self.pricing is None:
            return 0.0
        return self.pricing.cost_usd(self.prompt_tokens, self.completion_tokens)

    @property
    def cost_tracking(self) -> bool:
        """花费闸是否真的在记账（有定价 + 阈值 > 0 + 总开关开）"""
        return bool(self.limits.cost_enabled and self.pricing is not None)

    def record_round(
        self,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        prompt_text: str = "",
        reply_text: str = "",
    ) -> None:
        """累计一轮的 token（provider 返回真实 usage 时用真实值，否则本地估算）。"""
        self.rounds += 1
        if prompt_tokens is None:
            self.estimated = True
            prompt_tokens = _estimate_tokens(prompt_text)
        if completion_tokens is None:
            self.estimated = True
            completion_tokens = _estimate_tokens(reply_text)
        self.prompt_tokens += max(0, int(prompt_tokens))
        self.completion_tokens += max(0, int(completion_tokens))

    def remaining_seconds(self) -> float | None:
        """墙钟闸剩余秒数；墙钟闸关闭时返回 None（调用方据此不做限时等待）"""
        if not self.limits.wall_enabled:
            return None
        return self.limits.wall_clock_seconds - self.elapsed_seconds

    def _cost_reason(self) -> str:
        parts = [
            f"{COST_GATE_LABEL}（子任务已消费 ${self.spent_usd:.4f} "
            f"≥ 上限 ${self.limits.cost_limit_usd:g}；{self.pricing.describe() if self.pricing else '无定价'}；"
            f"累计 {self.prompt_tokens} 输入 / {self.completion_tokens} 输出 tokens"
            f"{'（token 数为本地估算）' if self.estimated else ''}）"
        ]
        if self.limits.wall_enabled and self.elapsed_seconds >= self.limits.wall_clock_seconds:
            parts.append(
                f"（墙钟亦超限：已耗时 {self.elapsed_seconds:.1f}s "
                f"≥ 上限 {self.limits.wall_clock_seconds:g}s）"
            )
        return "".join(parts)

    def _wall_reason(self) -> str:
        return (
            f"{WALL_GATE_LABEL}（子任务已耗时 {self.elapsed_seconds:.1f}s "
            f"≥ 上限 {self.limits.wall_clock_seconds:g}s；"
            f"已消费 ${self.spent_usd:.4f}·{self.rounds} 轮）"
        )

    def cost_trip(self) -> GateTrip | None:
        if not self.cost_tracking or self.spent_usd < self.limits.cost_limit_usd:
            return None
        return GateTrip(
            gate=GATE_COST,
            reason=self._cost_reason(),
            spent_usd=self.spent_usd,
            elapsed_seconds=self.elapsed_seconds,
            limit=self.limits.cost_limit_usd,
        )

    def wall_trip(self, force: bool = False) -> GateTrip | None:
        """墙钟归因。`force=True` 用于「本轮已被限时等待打断」的场景（不再重判阈值）。"""
        if not self.limits.wall_enabled:
            return None
        elapsed = self.elapsed_seconds
        if not force and elapsed < self.limits.wall_clock_seconds:
            return None
        return GateTrip(
            gate=GATE_WALL,
            reason=self._wall_reason(),
            spent_usd=self.spent_usd,
            elapsed_seconds=elapsed,
            limit=self.limits.wall_clock_seconds,
        )

    def check(self) -> GateTrip | None:
        """轮次边界的闸门判定：**先花费后墙钟**，任一超限即返回归因（调用方必须显式终止）。"""
        return self.cost_trip() or self.wall_trip()

    def summary_line(self) -> str:
        """一行账目（成功路径也可上报，便于对账）"""
        if self.pricing is None:
            price_text = "未定价（花费闸禁用）"
        else:
            price_text = f"${self.spent_usd:.4f}"
        return (
            f"花费 {price_text}｜{self.prompt_tokens} 输入 / {self.completion_tokens} 输出 tokens"
            f"{'（估算）' if self.estimated else ''}｜{self.rounds} 轮｜耗时 {self.elapsed_seconds:.1f}s"
        )
