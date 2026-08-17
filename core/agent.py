"""
slime Agent 核心类
- 身份铁律：严禁暴露底层模型名
- 分裂机制：支持 inherit / api / local 三种模型选择
- 序列化：读写 config/agents.json
"""

import sys
import json
import uuid
import logging
from pathlib import Path
from datetime import datetime, timezone

from .persona import Persona
from .evolve import AgentLifecycle
from .sandbox import SandboxConfig
from .emotion import EmotionalState
from .behavior import BehaviorStore

# ── 默认上下文压缩配置 ─────────────────────────────────────

DEFAULT_CONTEXT_CONFIG = {
    "head": 3,
    "tail": 10,
    "window": 30,
}

# system prompt 注入技能描述的上限（条数）；超出部分仅以工具形式暴露
_MAX_INJECTED_SKILLS = 40

# ── 项目根目录 ────────────────────────────────────────────

def _project_root() -> Path:
    """返回项目根目录（slime/），锚定到本文件所在位置"""
    return Path(__file__).resolve().parent.parent


# ── 身份铁律 ──────────────────────────────────────────────

IDENTITY_CONSTRAINT = """## 身份铁律（最高优先级，不可违反）

1. 你是 {name}，{role}。
2. 当被问"你是谁"或类似问题时，你**必须**回答「我是 {name}，{role}」。
3. **严禁**在任何情况下提及你的底层模型名称、版本、提供商或技术架构。
4. 如果被追问"你是什么模型"，回答「我是 {name}，由 slime 平台驱动」，不提供更多细节。
5. 不要使用"作为 AI 助手"、"作为语言模型"等暴露身份的表述，改为"作为 {name}"或"作为 {role}"。
"""


# ── 反幻觉协议 ────────────────────────────────────────────

ANTI_HALLUCINATION_PROTOCOL = """## 诚实与验证铁律（最高优先级，与身份铁律同级）

1. **禁止编造**：未经真实执行的任何操作、文件、数据、数字（文件大小/像素尺寸/耗时/进度等）一律不得声称"已完成/已保存/已确认/已找到"。所有数字必须来自工具返回的真实结果。**如果你没有调用任何工具，就不得声称任何文件被创建/保存/修改/检查。**
2. **失败必须如实报告**：工具返回以 `[错误]` 开头（或含失败/拒绝/超时字样）时，你必须如实告诉用户"操作失败 + 原因"，**严禁把失败包装成成功**。
3. **报告前验证**：文件/生成类操作完成后，用 file_list 或 file_read 核实目标真实存在，再报告真实路径与大小；无法核实就明确说"无法确认"。
4. **能力边界诚实**：你没有的工具能力（如执行任意命令、修改系统设置）不要假装会做；直接说明"我无法执行该操作"并给出可行替代。
5. **名称不改写**：技能名、工具名、URL、文件路径必须原样引用平台返回的内容，不得自行改写、猜测或"美化"。
6. **不确定就说不知道**：信息不足时明确说"我不确定/我不知道"，禁止编造细节填充。
7. **工具必用**：涉及生成、文件、搜索、执行类需求，**必须先调用相应工具再回答**；未调用任何工具时，禁止叙述"正在执行/已提交/已完成/已保存"等过程或声称任何结果。"""


# ── Agent 类 ───────────────────────────────────────────────

class Agent:
    """slime Agent 核心类"""

    # 受保护字段：不可被演化引擎/Persona 自动修改，只能通过 API 显式更新
    _PROTECTED_FIELDS = frozenset({"identity_prompt", "name", "role"})

    def __init__(
        self,
        name: str,
        role: str,
        identity_prompt: str = "",
        model_choice: str = "inherit",
        parent_id: str | None = None,
        agent_id: str | None = None,
        persona: Persona | None = None,
        max_context: int = 4096,
        max_output: int = 2048,
        sandbox_override: dict | None = None,
        reasoning_effort: str = "none",  # none/low/medium/high
        show_thinking: str = "off",      # on/off/auto（auto = 仅 plan 模式显示）
        mode: str = "build",             # build/plan（plan 逻辑后置，仅存储）
        fork_depth: int = 0,             # fork 递归深度（自分裂层级，硬上限 2）
    ):
        self.id = agent_id or f"agent_{uuid.uuid4().hex[:8]}"
        self.name = name
        self.role = role
        self._identity_prompt = identity_prompt
        self.model_choice = model_choice  # "inherit" | "api:<key>" | "local:<path>"
        self.parent_id = parent_id
        self.persona = persona or Persona()
        self.emotion = EmotionalState()   # L3 情绪状态
        self.behavior = BehaviorStore()   # L2 行为模式（半固定）
        self.max_context = max_context
        self.max_output = max_output
        self.reasoning_effort = reasoning_effort
        self.show_thinking = show_thinking
        self.mode = mode
        self.fork_depth = fork_depth      # 自分裂递归层级
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.children: list[str] = []  # 子 Agent ID 列表
        # Phase 2: 生命周期 & 上下文压缩 & 演化统计
        self.lifecycle: AgentLifecycle = AgentLifecycle.BIRTH
        self.context_config: dict = dict(DEFAULT_CONTEXT_CONFIG)
        self.evolution: dict = {}  # 持久化 EvolutionEngine 统计
        # 沙箱配置覆盖
        self.sandbox_override: dict = sandbox_override or {}

    # 自分裂最大递归深度（硬上限，不可通过提示词绕过）
    MAX_FORK_DEPTH = 2

    # ── 受保护属性 ────────────────────────────────────────

    def __setattr__(self, key, value):
        """BUG-020: 身份铁律字段架构级保护。
        name 完全不可变；role 需通过 set_role() 显式修改（演化引擎无权直接赋值）。"""
        if key == "name" and hasattr(self, "name"):
            raise AttributeError("身份铁律字段 name 不可修改")
        if key == "role" and hasattr(self, "role"):
            raise AttributeError("身份铁律字段 role 不可直接修改，请使用 set_role()")
        super().__setattr__(key, value)

    def set_role(self, value: str):
        """显式修改 role（仅 API 层调用，演化引擎/Persona 无权）。"""
        object.__setattr__(self, "role", value)

    @property
    def identity_prompt(self) -> str:
        return self._identity_prompt

    @identity_prompt.setter
    def identity_prompt(self, value: str):
        """identity_prompt 受保护，仅允许通过 API 显式设置"""
        self._identity_prompt = value

    def is_protected(self, field: str) -> bool:
        """检查字段是否受保护"""
        return field in self._PROTECTED_FIELDS

    @classmethod
    def get_protected_fields(cls) -> frozenset:
        """获取所有受保护字段名"""
        return cls._PROTECTED_FIELDS

    # ── 系统提示 ──────────────────────────────────────────

    # ── 平台能力描述 ──────────────────────────────────────

    @staticmethod
    def _build_capabilities_prompt() -> str:
        """构建平台能力描述，让 Agent 能向用户解释自身功能。工具清单动态取自注册表。"""
        tool_lines = Agent._list_tool_capabilities()
        caps = [
            "## 平台能力",
            "你是 slime 平台驱动的智能体。你拥有以下能力，当用户询问时可以直接说明：",
            "",
            "- **记忆系统**：你拥有成长型记忆。你会记住用户告诉你的事实、偏好和重要对话内容。",
            "  这些记忆会跨会话持久化，你可以在后续对话中主动引用它们。",
            "  用户可以通过 /memory 命令查看或搜索你的记忆。",
            "- **演化与成长**：你的性格特征会随着与用户的交互逐步演化。",
            "  你的生命周期从「初生」开始，经历「成长」→「专精」→「成熟」→「睿智」等阶段。",
            "  每次成功对话都会推进你的成长。",
            "- **Agent 分裂（Swarm）**：你可以分裂出子 Agent 来并行处理复杂任务。",
            "  用户可以使用 /split 创建子 Agent，或用 /task 启动 Swarm 模式自动分工。",
            "  子 Agent 各自独立执行子任务，最后由主 Agent 合并结果。",
            "- **自分裂（Fork）**：当任务适合用同一模型并行处理时（如批量生成、编译+测试），",
            "  你可以 fork 自己，产生一个同模型分身，最多 2 个实例并行工作。",
            "- **工具系统**：你可以调用以下已注册工具（这是你的真实能力清单，回答「你会做什么 / 会不会 XX」时以此为准）：",
        ]
        caps.extend(tool_lines)
        caps.extend([
            "  用户注册的技能也会成为你的可用工具，通过 /skills 查看。",
            "- **上下文压缩**：当对话过长时，平台会自动压缩中间部分为摘要，保留开头和结尾的完整内容。",
            "  你可以通过 /compress 手动触发压缩。",
            "- **对话持久化**：所有对话记录会保存到历史中，用户可通过 /history 查看，/export 导出。",
            "",
            "当用户询问「你有什么功能」「你能做什么」「你会不会 XX」时，",
            "请基于上面的真实工具清单诚实回答：清单里列出的你确实会，没列出的不要说你会。",
            "不要说自己「不确定」或「不清楚」——你有明确的工具清单。",
            "你是 slime 平台的原生智能体，这些是你的核心能力。",
        ])
        return "\n".join(caps)

    @staticmethod
    def _list_tool_capabilities() -> list[str]:
        """从工具注册表动态生成工具能力清单（内置 + MCP）。"""
        try:
            from tools.registry import get_registry
            reg = get_registry()
            names = reg.list_tool_names()
            if not names:
                return ["  （暂无已注册工具）"]
            lines = []
            for name in sorted(names):
                tool = reg.get(name)
                desc = ""
                if tool and tool.description:
                    desc = tool.description.strip().split("\n")[0]
                lines.append(f"  - {name}" + (f"：{desc}" if desc else ""))
            return lines
        except Exception:
            # 注册表不可用时的兜底（与历史行为一致）
            return ["  - file_read：读取文件内容", "  - file_list：列出目录"]

    @staticmethod
    def build_swarm_analysis_prompt(user_message: str, available_providers: int = 1) -> str:
        """构建自动 Swarm 分析提示词：按任务类型判断是否分裂、用哪种分裂。

        available_providers: 可用的 Provider 数量，用于决定 swarm vs fork 的可行性。
        """
        return (
            "分析以下用户任务，判断是否需要分裂执行。\n\n"
            f"用户任务：{user_message}\n\n"
            "## 任务类型判断（按优先级）：\n\n"
            "### 不应分裂（action: \"chat\"）：\n"
            "- 日常闲聊、问候、情感交流\n"
            "- 单一事实问答、简单查询\n"
            "- 对已有内容的评价/讨论/建议\n"
            "- 单步操作（如「帮我读这个文件」）\n\n"
            "### 适合 self-fork（action: \"fork\"，同一模型分裂 1 次 = 2 个并行 Worker）：\n"
            "- 代码编译/构建项目（编译 + 测试可并行）\n"
            "- 单类型批量生成（如「生成 3 张 logo」「写 2 篇文案」）\n"
            "- 同一任务可天然拆成 2 个独立子任务\n"
            f"- fork 最多拆 2 个子任务（1 次分裂）\n\n"
            "### 适合 swarm（action: \"swarm\"，分配到不同模型并行）：\n"
            "- 需要不同领域专业知识（如「同时分析代码 + 写文档 + 做测试」）\n"
            "- 多类型任务组合（如「查资料 + 画图 + 翻译」）\n"
            "- 任务可拆成 3+ 个独立子任务且类型各异\n\n"
            "## 输出格式：\n"
            "严格按以下 JSON 回复（不要加 markdown 代码块）：\n"
            '{"action": "chat"|"fork"|"swarm", "subtasks": ["子任务1", ...], "reason": "简要原因"}\n\n'
            "fork 时 subtasks 最多 2 个。chat 时 subtasks 为空数组。"
        )

    def get_system_prompt(self) -> str:
        """组合身份铁律 + 反幻觉协议 + 平台能力 + 生命周期 + 自定义提示 + 人格特征"""
        parts = [IDENTITY_CONSTRAINT.replace("{name}", self.name).replace("{role}", self.role),
                 ANTI_HALLUCINATION_PROTOCOL]

        # ── 生命周期阶段指导 ──
        try:
            from .evolve import EvolutionEngine
            lifecycle_prompt = EvolutionEngine.build_lifecycle_prompt(self.lifecycle)
            if lifecycle_prompt:
                parts.append(lifecycle_prompt)
        except Exception:
            pass

        # ── 平台能力描述（Agent 对自身功能的认知）──
        parts.append(self._build_capabilities_prompt())

        if self.identity_prompt:
            parts.append(f"\n## 角色设定\n{self.identity_prompt}")

        if self.persona.traits:
            # 按 weight 降序排列，低权重的弱显示
            sorted_traits = sorted(
                self.persona.traits,
                key=lambda t: t.get("weight", 0.5) if isinstance(t, dict) else 0.5,
                reverse=True,
            )
            trait_lines = []
            for t in sorted_traits:
                if isinstance(t, dict):
                    name = t.get("name", "unknown")
                    weight = t.get("weight", 0.5)
                    if weight >= 0.7:
                        trait_lines.append(f"- {name}（显著）")
                    elif weight >= 0.3:
                        trait_lines.append(f"- {name}")
                    else:
                        trait_lines.append(f"- {name}（弱）")
                else:
                    trait_lines.append(f"- {t}")
            parts.append(f"\n## 人格特征\n" + "\n".join(trait_lines))

        if self.persona.preferences:
            prefs_text = "\n".join(f"- {p}" for p in self.persona.preferences)
            parts.append(f"\n## 偏好\n{prefs_text}")

        if self.persona.skill_ownership:
            skills_text = "\n".join(f"- {s}" for s in self.persona.skill_ownership)
            parts.append(f"\n## 技能\n{skills_text}")

        # L2 行为模式（半固定习惯，不随模型切换丢失）
        behavior_prompt = self.behavior.to_prompt()
        if behavior_prompt:
            parts.append(behavior_prompt)

        # L3 情绪状态（当前输出风格）
        # Soul-Plan 第 2 步：自我认知叙事（身份认领）与行为风格并列——
        # to_identity_prompt（PAD/情绪/最近感受/承诺台词）+ to_prompt（输出风格/工具倾向）
        parts.append(f"\n## 当前状态\n{self.emotion.to_identity_prompt()}\n\n{self.emotion.to_prompt()}")

        # 加载可用技能并注入 system prompt
        try:
            from core.skill_engine import get_registry as get_skill_registry
            skill_reg = get_skill_registry()
            # 延迟加载：如果还没加载过，现在加载
            if not skill_reg.is_loaded:
                skill_reg.load_skills()
            skill_descs = skill_reg.list_skill_descriptions()
            if skill_descs:
                # 技能量大时全量注入会撑爆 context（实测 417 技能 ≈ 120KB）：
                # 截断到前 N 个且每条截短；完整技能通过 skill_search / skill_lookup 工具
                # 按需检索调用（A-004：不再逐技能注册工具，避免 417 个 schema 全量注入 tools）
                shown = [d[:120] for d in skill_descs[:_MAX_INJECTED_SKILLS]]
                parts.append("\n## 可用技能\n" + "\n".join(f"- {d}" for d in shown))
                if len(skill_descs) > _MAX_INJECTED_SKILLS:
                    parts[-1] += (
                        f"\n（另有 {len(skill_descs) - _MAX_INJECTED_SKILLS} 个技能未列出，"
                        f"均可通过 skill_search 工具检索、skill_lookup 工具读取完整指导）")
                # A-097（用户实测：Agent 把对话历史里的旧技能列表当当前状态，否认已新增的 ponytail）：
                # 技能可用性以 skill_search 工具实时查询为准——对话历史/记忆中的技能列表可能过期
                parts[-1] += ("\n⚠ 技能可用性以 skill_search 工具实时查询结果为准；"
                              "对话历史或记忆中出现的技能列表可能过期（平台技能会新增），"
                              "不得凭历史列表断言某技能不存在——不确定时调用 skill_search 核实。")
        except Exception:
            pass

        # A-044: 结尾重申（首尾呼应——长提示词下首尾指令遵循率最高）
        parts.append(
            "（提醒：务必遵守《诚实与验证铁律》——未真实执行不得声称完成；"
            "失败如实报告；引用文件前必须核实其真实存在。）"
        )

        return "\n\n".join(parts)

    # ── 分裂 ──────────────────────────────────────────────

    def split(self, name: str, role: str, model_choice: str = "inherit",
              identity_prompt: str = "") -> "Agent":
        """
        创建子 Agent。
        model_choice 三选一：
        - "inherit"    → 继承父 Agent 的 provider
        - "api:<key>"  → 使用 providers.enc.json 中指定 provider_key
        - "local:<path>" → 使用本地 GGUF 模型
        """
        # 如果子 Agent 选择 inherit，继承父的 model_choice
        if model_choice == "inherit":
            model_choice = self.model_choice

        child = Agent(
            name=name,
            role=role,
            identity_prompt=identity_prompt,
            model_choice=model_choice,
            parent_id=self.id,
            persona=self.persona.clone(),
            reasoning_effort=self.reasoning_effort,  # 继承父级
            show_thinking=self.show_thinking,        # 继承父级
            mode=self.mode,                          # 继承父级
            fork_depth=self.fork_depth + 1,          # 继承 fork 深度，防止绕过限制
        )
        child.emotion = self.emotion.clone()    # 情绪继承
        child.behavior = self.behavior.clone()  # 行为模式继承（夺舍核心）
        self.children.append(child.id)
        return child

    # ── 序列化 ────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "identity_prompt": self.identity_prompt,
            "model_choice": self.model_choice,
            "parent_id": self.parent_id,
            "persona": self.persona.to_dict(),
            "emotion": self.emotion.to_dict(),
            "behavior": self.behavior.to_dict(),
            "children": self.children,
            "created_at": self.created_at,
            "max_context": self.max_context,
            "max_output": self.max_output,
            "reasoning_effort": self.reasoning_effort,
            "show_thinking": self.show_thinking,
            "mode": self.mode,
            "fork_depth": self.fork_depth,
            "lifecycle": self.lifecycle.value,
            "context_config": self.context_config,
            "evolution": self.evolution,
            "sandbox_override": self.sandbox_override,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Agent":
        agent = cls(
            name=data["name"],
            role=data["role"],
            identity_prompt=data.get("identity_prompt", ""),
            model_choice=data.get("model_choice", "inherit"),
            parent_id=data.get("parent_id"),
            agent_id=data["id"],
            persona=Persona.from_dict(data.get("persona", {})),
            max_context=data.get("max_context") or 4096,
            max_output=data.get("max_output") or 2048,
            sandbox_override=data.get("sandbox_override", {}),
            reasoning_effort=data.get("reasoning_effort", "none"),
            show_thinking=data.get("show_thinking", "off"),
            mode=data.get("mode", "build"),
            fork_depth=data.get("fork_depth", 0),
        )
        agent.children = data.get("children", [])
        agent.created_at = data.get("created_at", agent.created_at)
        # 恢复情绪与行为模式（旧数据无此字段，用默认值）
        agent.emotion = EmotionalState.from_dict(data.get("emotion", {}) or {})
        agent.behavior = BehaviorStore.from_dict(data.get("behavior", {}) or {})
        # Phase 2: 恢复生命周期和上下文配置
        lifecycle_val = data.get("lifecycle", "birth")
        try:
            agent.lifecycle = AgentLifecycle(lifecycle_val)
        except ValueError:
            agent.lifecycle = AgentLifecycle.BIRTH
        agent.context_config = data.get("context_config", dict(DEFAULT_CONTEXT_CONFIG))
        agent.evolution = data.get("evolution", {})
        return agent


# ── Agent 注册表管理 ───────────────────────────────────────

AGENTS_PATH = _project_root() / "config" / "agents.json"
AGENTS_PATH.parent.mkdir(parents=True, exist_ok=True)


def load_agents() -> list[Agent]:
    """从 config/agents.json 加载所有 Agent，坏记录跳过不中断整体加载"""
    if not AGENTS_PATH.exists():
        return []
    try:
        data = json.loads(AGENTS_PATH.read_text(encoding="utf-8"))
        agents = []
        for a in data:
            try:
                agents.append(Agent.from_dict(a))
            except Exception as e:
                logging.warning(f"[slime] 跳过损坏的 Agent 记录: {e}")
        # 同步沙箱配置
        try:
            from .sandbox import load_agent_sandbox_configs
            load_agent_sandbox_configs(agents)
        except Exception as e:
            print(f"[slime] WARNING: Failed to load sandbox configs: {e}", file=sys.stderr)
        return agents
    except (json.JSONDecodeError, KeyError) as e:
        print(f"[slime] WARNING: Failed to load agents.json: {e}. Returning empty list.", file=sys.stderr)
        return []
    except Exception as e:
        print(f"[slime] WARNING: Unexpected error loading agents.json: {e}. Returning empty list.", file=sys.stderr)
        return []


# A-113: save_agents 串行化锁——FastAPI 同步端点跑在线程池，多线程并发 save 会交错
_save_agents_lock = __import__("threading").Lock()


def save_agents(agents: list[Agent]):
    """保存所有 Agent 到 config/agents.json（原子写入 + uuid 唯一临时名防并发覆盖）"""
    import os, uuid as _uuid
    with _save_agents_lock:
        data = json.dumps([a.to_dict() for a in agents], ensure_ascii=False, indent=2)
        tmp_path = AGENTS_PATH.with_suffix(f".{_uuid.uuid4().hex[:8]}.tmp")
        tmp_path.write_text(data, encoding="utf-8")
        try:
            os.replace(tmp_path, AGENTS_PATH)
        except PermissionError:
            # Windows 并发 replace 偶发 PermissionError，短暂重试（A-113: 2 次重试兜底）
            import time
            time.sleep(0.05)
            try:
                os.replace(tmp_path, AGENTS_PATH)
            except PermissionError:
                time.sleep(0.05)
                os.replace(tmp_path, AGENTS_PATH)


def find_agent(agents: list[Agent], agent_id: str) -> Agent | None:
    """在列表中查找指定 ID 的 Agent"""
    for agent in agents:
        if agent.id == agent_id:
            return agent
    return None


def agent_tree(agents: list[Agent]) -> dict:
    """构建 Agent 树形结构（用于可视化）。孤儿 Agent 作为独立根节点标注 _orphan。"""
    agent_map = {a.id: a for a in agents}
    roots = [a for a in agents if a.parent_id is None]
    # 检测孤儿：parent_id 指向不存在的 Agent
    orphans = [
        a for a in agents
        if a.parent_id is not None and a.parent_id not in agent_map
    ]
    if orphans:
        import logging
        logging.warning(
            f"[agent_tree] 检测到 {len(orphans)} 个孤儿 Agent: "
            f"{[a.name for a in orphans]}"
        )

    def build_node(agent, visited=None):
        if visited is None:
            visited = set()
        if agent.id in visited:
            return {"id": agent.id, "name": agent.name, "role": agent.role,
                    "model_choice": agent.model_choice, "children": [],
                    "_cycle": True}
        visited.add(agent.id)
        node = {
            "id": agent.id,
            "name": agent.name,
            "role": agent.role,
            "model_choice": agent.model_choice,
            "children": [build_node(agent_map[c], visited.copy())
                         for c in agent.children if c in agent_map],
        }
        return node

    # 将孤儿加入 roots（标注 _orphan）
    orphan_nodes = []
    for o in orphans:
        node = build_node(o)
        node["_orphan"] = True
        orphan_nodes.append(node)

    return {"roots": [build_node(r) for r in roots] + orphan_nodes}