"""
slime FastAPI 后端服务
端口 19000，提供 REST API 接口
"""

import json
import os
import time
import secrets
import asyncio
import logging
from pathlib import Path
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from core.encryption import encrypt, decrypt
from core.agent import Agent, load_agents, save_agents, find_agent, agent_tree
from core.persona import Persona
from core.llm import call_llm, call_llm_with_meta, call_llm_stream, MAX_OUTPUT_LIMIT, MAX_CONTEXT_LIMIT
from core.global_config import load_global_config, save_global_config, get_defaults
from core.history import append as history_append, load as history_load, pop_last as history_pop_last
from core.novelty import bigrams, is_short_confirmation
from core.memory import load_memory, extract_memories_from_chat
from core.context import ContextCompressor
from core.evolve import EvolutionEngine
from tools.registry import get_registry
from social.base import WeChatWorkAdapter
# A-018: 模块级导入 ServerA2ABus —— /chat 与 /chat/stream 都依赖它；
# 此前仅 lifespan 内函数级导入，/chat 端点每次调用 NameError（流式主路径掩盖了该崩溃）
from core.a2a import ServerA2ABus
from core.mcp_client import get_mcp_client


# ── slime.toml 配置读取 ────────────────────────────────────

_TOML_PATH = Path(__file__).parent / "slime.toml"


def _load_toml_config() -> dict:
    """读取 slime.toml 配置（简单解析，不依赖 tomllib）"""
    try:
        import tomllib
    except ImportError:
        # Python < 3.11 fallback
        tomllib = None

    if tomllib:
        try:
            with open(_TOML_PATH, "rb") as f:
                return tomllib.load(f)
        except Exception as e:
            logging.warning(f"[slime] 读取 slime.toml 失败: {e}")
            return {}
    else:
        # 简易解析（仅支持 [section] key = value 格式）
        config = {}
        if not _TOML_PATH.exists():
            return config
        try:
            current_section = None
            _current_array_dict = None  # [[array_of_tables]] 写入目标
            for line in _TOML_PATH.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("[") and line.endswith("]"):
                    _current_array_dict = None  # 新 section 重置数组写入目标
                    current_section = line[1:-1]
                    # 支持 [[array_of_tables]] 语法
                    is_array = line.startswith("[[") and line.endswith("]]")
                    if is_array:
                        current_section = line[2:-2]
                        # 初始化数组，追加新元素
                        parts = current_section.split(".")
                        ptr = config
                        for part in parts[:-1]:
                            ptr = ptr.setdefault(part, {})
                        arr = ptr.setdefault(parts[-1], [])
                        arr.append({})
                        current_section = None  # key=value 直接写入 arr[-1]
                        _current_array_dict = arr[-1]
                        continue
                    # M1: 将 flat 键 "a.b" 归一化为嵌套 {a: {b: {}}}
                    parts = current_section.split(".")
                    ptr = config
                    for part in parts[:-1]:
                        ptr = ptr.setdefault(part, {})
                    ptr.setdefault(parts[-1], {})
                elif "=" in line and (
                    current_section or _current_array_dict is not None
                ):
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip('"')
                    if v.lower() in ("true", "false"):
                        v = v.lower() == "true"
                    elif v.isdigit():
                        v = int(v)
                    elif v.startswith("[") and v.endswith("]"):
                        # M1: 数组字面量 [0, 1] → 解析为 list（防 string 子串误判 fail-open）
                        inner = v[1:-1]
                        try:
                            v = [int(x.strip()) for x in inner.split(",") if x.strip()]
                        except ValueError:
                            v = [x.strip().strip('"') for x in inner.split(",") if x.strip()]
                    if _current_array_dict is not None:
                        _current_array_dict[k] = v
                    else:
                        # M1: 写入嵌套路径
                        parts = current_section.split(".")
                        ptr = config
                        for part in parts[:-1]:
                            ptr = ptr.setdefault(part, {})
                        ptr.setdefault(parts[-1], {})[k] = v
            return config
        except Exception as e:
            logging.warning(f"[slime] 解析 slime.toml 失败: {e}")
            return {}


_SLIME_CONFIG = _load_toml_config()


# ── 端口配置 ──────────────────────────────────────────────

try:
    SLIME_PORT = int(os.environ.get("SLIME_PORT", "19000"))
except (ValueError, TypeError):
    SLIME_PORT = 19000
    logging.warning(f"[slime] SLIME_PORT 环境变量值无效，回退默认 {SLIME_PORT}")


# ── 认证令牌管理 ──────────────────────────────────────────

# A-045: 委托执行期间的心跳间隔（秒）——生图/生视频类委托可达数分钟，
# 无心跳时 SSE 静默期会触发客户端读超时
_HEARTBEAT_INTERVAL = 15.0

_CONFIG_DIR = Path(__file__).parent / "config"
_AUTH_TOKEN_PATH = _CONFIG_DIR / "auth_token.json"
_AUTH_TOKEN_ENC_PATH = _CONFIG_DIR / "auth_token.enc"


def _get_or_create_auth_token() -> str:
    """首次启动生成 auth token（加密存储），后续读取解密"""
    from core.encryption import encrypt_raw, decrypt_raw

    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)

    # 优先读取加密格式
    if _AUTH_TOKEN_ENC_PATH.exists():
        token = decrypt_raw(str(_AUTH_TOKEN_ENC_PATH))
        if token:
            return token

    # 兼容旧版明文格式（自动迁移到加密格式）
    if _AUTH_TOKEN_PATH.exists():
        try:
            token = json.loads(_AUTH_TOKEN_PATH.read_text(encoding="utf-8"))["token"]
            # 迁移：加密存储后删除明文文件
            encrypt_raw(token, str(_AUTH_TOKEN_ENC_PATH))
            _set_file_permissions(_AUTH_TOKEN_ENC_PATH)
            try:
                _AUTH_TOKEN_PATH.unlink()
            except Exception:
                pass
            return token
        except (json.JSONDecodeError, KeyError):
            pass

    # 生成新 token 并加密存储
    token = secrets.token_hex(32)
    encrypt_raw(token, str(_AUTH_TOKEN_ENC_PATH))
    _set_file_permissions(_AUTH_TOKEN_ENC_PATH)
    return token


def _set_file_permissions(path: Path):
    """设置文件权限（Windows: 隐藏 + ACL 限制；Unix: 0o600）。

    A-112: icacls 失败不再静默——检查 returncode 并打 warning（失败不阻塞）。
    """
    if os.name == "nt":
        import ctypes
        ctypes.windll.kernel32.SetFileAttributesW(str(path), 2)  # FILE_ATTRIBUTE_HIDDEN
        user = os.environ.get("USERNAME", "")
        if not user:
            logging.warning(f"[auth] USERNAME 为空，跳过 icacls 权限限制: {path}")
            return
        try:
            import subprocess
            r = subprocess.run(
                ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:(M)"],
                capture_output=True, timeout=5,
            )
            if r.returncode != 0:
                logging.warning(
                    f"[auth] icacls 权限限制失败 {path}: rc={r.returncode} "
                    f"{r.stderr.decode(errors='replace').strip()}"
                )
        except Exception as e:
            logging.warning(f"[auth] icacls 执行异常 {path}: {e}")
    else:
        path.chmod(0o600)


AUTH_TOKEN = _get_or_create_auth_token()


# ── 全局状态 ──────────────────────────────────────────────

agents: list[Agent] = []
_agents_lock = __import__('threading').Lock()
_evolve_lock = None  # 延迟初始化：asyncio.Lock 需在事件循环内创建
_evolve_lock_init = __import__('threading').Lock()  # N12-1: 保护初始化竞态
_background_tasks: set = set()  # N11-P2-1: 持有后台任务引用，防 GC 回收


def _spawn_background(coro):
    """创建后台任务并持有引用，完成时自动丢弃（N11-P2-1）"""
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


def _get_evolve_lock():
    """返回 per-agent 演化锁（asyncio.Lock，线程安全惰性初始化）"""
    global _evolve_lock
    if _evolve_lock is None:
        with _evolve_lock_init:  # N12-1: 双检锁，防多线程创建多个 Lock
            if _evolve_lock is None:
                _evolve_lock = asyncio.Lock()
    return _evolve_lock


async def _periodic_review_loop():
    """睡眠巩固：周期性审查知识引擎 + 沉淀行为模式（BUG-004/018）。
    每小时触发一次，模拟人脑睡眠时整理记忆。BUG-013: 加锁防与 post_process 并发。"""
    try:
        while True:
            await asyncio.sleep(3600)
            for agent in agents:
                try:
                    async with _get_evolve_lock():  # BUG-013: 与 _post_process_chat 互斥
                        from core.knowledge import get_knowledge_engine
                        from core.consolidation import ConsolidationEngine
                        memory_cfg = _SLIME_CONFIG.get("memory", {})
                        ke = get_knowledge_engine(agent.id, data_dir=memory_cfg.get("dir", ""))
                        ke.review(agent_persona=agent.persona)
                        # BUG-018: 统一的沉淀引擎（L3→L2）
                        ConsolidationEngine().consolidate(agent, knowledge_engine=ke)
                        save_agents(agents)
                except Exception as e:
                    logging.debug(f"[slime] 睡眠巩固失败 ({agent.name if agent else '?'}): {e}")
    except asyncio.CancelledError:
        pass


# ── 生命周期 ──────────────────────────────────────────────

def _build_mcp_provider_env(only=None) -> dict:
    """从加密 providers 提取 LLM 环境变量，注入声明 inject_provider_keys 的 MCP 子进程
    （如 browser-use，其浏览器代理靠 LLM 驱动）。

    最小权限注入（P1-10 修复）：只注入调用方声明的 provider——
      inject_provider_keys = true          → 仅注入已知标准映射的 provider（openai/anthropic/google/gemini/deepseek），未知名不注入
      inject_provider_keys = ["openai", …] → 显式白名单，仅注入列出的 provider
      inject_provider_keys = "anthropic"   → 单个 provider
    显式点名但无标准映射的 provider 视为 OpenAI 兼容（OPENAI_API_KEY + OPENAI_BASE_URL）。
    不再全量注入全部 key 到第三方子进程；slime.toml 不留明文 key。
    """
    from core.encryption import decrypt
    providers = decrypt() or {}
    known = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "google": "GOOGLE_API_KEY",
        "gemini": "GOOGLE_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY",
    }
    if only is not None:
        only = {str(x).lower() for x in only}
    env: dict = {}
    for key, cfg in providers.items():
        api_key = cfg.get("api_key")
        if not api_key:
            continue
        name = str(key).lower()
        if only is not None and name not in only:
            continue
        var = known.get(name)
        if var:
            env[var] = api_key
        elif only is not None:
            env.setdefault("OPENAI_API_KEY", api_key)
            env.setdefault("OPENAI_BASE_URL", cfg.get("api_base") or "")
    return env


@asynccontextmanager
async def lifespan(app: FastAPI):
    global agents
    # 初始化沙箱系统：从 slime.toml 加载 [sandbox] 配置
    from core.sandbox import reset_sandbox_manager, SandboxConfig, ApprovalDecision, PermissionRequest
    sandbox_toml = _SLIME_CONFIG.get("sandbox", {})
    sandbox_cfg = SandboxConfig.from_dict(sandbox_toml) if isinstance(sandbox_toml, dict) else SandboxConfig()

    # Server 端确认回调：返回需确认（不阻塞，实际确认由 CLI 端处理）
    def _server_approval(req: PermissionRequest) -> ApprovalDecision:
        return ApprovalDecision(
            request_id=req.request_id,
            approved=False,
            reason="Server 端不处理确认，请在 CLI 端操作",
        )

    reset_sandbox_manager(config=sandbox_cfg, approval_callback=_server_approval)

    agents = load_agents()  # load_agents 内部会调用 load_agent_sandbox_configs
    # 启动时补齐全局默认值（只升级不降级）
    defaults = get_defaults()
    for agent in agents:
        if not agent.max_context or agent.max_context < defaults["max_context"]:
            agent.max_context = defaults["max_context"]
        if not agent.max_output or agent.max_output < defaults["max_output"]:
            agent.max_output = defaults["max_output"]
    # 注册内置只读工具
    from tools.builtin import register_builtin_tools
    register_builtin_tools()
    # A-035/A-048: 注册 Agnes 同厂媒体工具（agnes_prompt_build/generate_image/video/status）
    from tools.agnes_media import register_agnes_media_tools
    register_agnes_media_tools()

    # 启动时加载技能并注册 skill_search/skill_lookup 工具（A-004：不逐技能注册，避免 tools 数组爆炸；/skills/load 可热更新）
    from core.skill_engine import load_all_skills
    load_all_skills()

    # 初始化常驻 A2A 总线，注册所有持久 Agent
    from core.a2a import ServerA2ABus
    bus = ServerA2ABus()
    for a in agents:
        bus.register(a.name)
    logging.info(f"[slime] A2A 总线已启动，已注册 {len(agents)} 个 Agent")

    # 初始化本地模型管理（后台异步拉 embedding，不阻塞 server）
    from core.model_server import ModelServerManager, set_model_server
    model_cfg = _SLIME_CONFIG.get("model_server", {})
    if model_cfg:
        model_mgr = ModelServerManager(model_cfg)
        set_model_server(model_mgr)
        await model_mgr.startup()  # startup 内部已是 create_task 异步，此处即刻返回
        logging.info("[slime] 本地模型管理器已就绪（embedding 后台加载中）")

    # 初始化 MCP Client，连接配置的 MCP Server
    mcp_servers = _SLIME_CONFIG.get("mcp_servers", [])
    if mcp_servers:
        mcp = get_mcp_client()
        for srv_cfg in mcp_servers:
            if not isinstance(srv_cfg, dict) or not srv_cfg.get("name"):
                continue
            if not (srv_cfg.get("command") or srv_cfg.get("url")):
                continue
            env = dict(srv_cfg.get("env") or {})
            inject = srv_cfg.get("inject_provider_keys")
            if inject:
                only = None if inject is True else ([inject] if isinstance(inject, str) else list(inject))
                mcp_provider_env = _build_mcp_provider_env(only)  # 每次按白名单独立解密，杜绝全量注入
                env = {**mcp_provider_env, **env}  # 显式 env 覆盖注入值
            mcp.add_server(
                name=srv_cfg["name"],
                command=srv_cfg.get("command", ""),
                args=srv_cfg.get("args", []),
                env=env or None,
                url=srv_cfg.get("url", ""),
                headers=srv_cfg.get("headers", None),
                timeout=srv_cfg.get("timeout"),
                tool_permissions=srv_cfg.get("tool_permissions"),
                # P2-5: OAuth 2.1（仅 url 型 server 生效）
                oauth=srv_cfg.get("oauth", False),
                oauth_scopes=srv_cfg.get("oauth_scopes"),
                oauth_client_id=srv_cfg.get("oauth_client_id"),
                oauth_redirect_port=srv_cfg.get("oauth_redirect_port"),
            )
        results = await mcp.start_all()
        ok = sum(1 for v in results.values() if v)
        logging.info(f"[slime] MCP Client 已就绪：{ok}/{len(results)} 个 Server 启动成功")

    # 睡眠巩固后台任务（BUG-004）
    review_task = asyncio.create_task(_periodic_review_loop())

    yield

    review_task.cancel()
    # 关闭 MCP Server
    mcp = get_mcp_client()
    await mcp.stop_all()
    # 关闭本地模型
    if model_cfg:
        await model_mgr.shutdown()
    save_agents(agents)


app = FastAPI(title="slime", version="0.1.0", lifespan=lifespan)

# CORS 收窄为本地（A-112: methods/headers 不再通配，仅放行实际使用的集合）
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://127.0.0.1:{SLIME_PORT}"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
)


# ── 认证中间件 ────────────────────────────────────────────

# BUG-030: /docs /openapi.json /redoc 不再免认证，公网部署不泄露 API 结构
_AUTH_EXEMPT = {"/health", "/social/webhook"}


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path in _AUTH_EXEMPT:
        return await call_next(request)
    auth = request.headers.get("Authorization", "")
    if auth != f"Bearer {AUTH_TOKEN}":
        return JSONResponse(
            status_code=401,
            content={"detail": "Unauthorized"},
        )
    return await call_next(request)


# ── 速率限制中间件（A-112: 按客户端 IP 滑动窗口限流） ───────

_RATE_WINDOW = 60.0
_RATE_MAX = 120  # 120 次/分钟，宽松阈值：本地 CLI 单次会话远低于此，不干扰测试
_rate_hits: dict = {}
_rate_lock = __import__("threading").Lock()  # 与 _agents_lock 同模式，threading 非顶层导入


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    if request.url.path in _AUTH_EXEMPT:
        return await call_next(request)
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with _rate_lock:
        hits = [t for t in _rate_hits.get(ip, []) if now - t < _RATE_WINDOW]
        if len(hits) >= _RATE_MAX:
            _rate_hits[ip] = hits
            return JSONResponse(
                status_code=429,
                content={"detail": "Too Many Requests"},
            )
        hits.append(now)
        _rate_hits[ip] = hits
        if len(_rate_hits) > 1024:  # 防僵尸 IP 条目无限增长
            _rate_hits.clear()
    return await call_next(request)


# ── 请求 ID 中间件（A-112: 注入/透传 X-Request-ID，日志可串联） ──

@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    rid = request.headers.get("X-Request-ID") or f"req_{secrets.token_hex(6)}"
    request.state.request_id = rid
    response = await call_next(request)
    response.headers["X-Request-ID"] = rid
    return response


# ── Pydantic 模型 ─────────────────────────────────────────

class AgentCreate(BaseModel):
    name: str = Field(..., max_length=100)
    role: str = Field(..., max_length=500)
    identity_prompt: str = Field(default="", max_length=5000)
    model_choice: str = Field(default="inherit", max_length=100)


class AgentSplit(BaseModel):
    name: str = Field(..., max_length=100)
    role: str = Field(..., max_length=500)
    model_choice: str = Field(default="inherit", max_length=100)
    identity_prompt: str = Field(default="", max_length=5000)


class ChatRequest(BaseModel):
    message: str = Field(..., max_length=10000)  # A-112: 防超长消息耗尽上下文/配额
    history: list[dict] = Field(default_factory=list, max_length=50)  # 多轮对话历史 [{role, content}, ...]
    retry: bool = False       # /retry 标记：写入历史前先移除上一条（避免重复记录）


class ProviderSave(BaseModel):
    key: str = Field(..., max_length=100)
    api_base: str = Field(..., max_length=500)
    api_key: str = Field(..., max_length=500)
    model: str = Field(default="", max_length=200)
    max_context: int = 0
    max_output: int = 0


# ── 路由 ──────────────────────────────────────────────────


@app.get("/health")
def health():
    """存活探测（免认证）"""
    return {"status": "ok", "agent_count": len(agents)}


@app.get("/agents")
def list_agents():
    """列出所有 Agent"""
    return [a.to_dict() for a in agents]


@app.get("/agents/tree")
def get_agent_tree():
    """获取 Agent 树形结构"""
    return agent_tree(agents)


@app.post("/agents")
def create_agent(req: AgentCreate):
    """创建 Agent（向导用）"""
    agent = Agent(
        name=req.name,
        role=req.role,
        identity_prompt=req.identity_prompt,
        model_choice=req.model_choice,
    )
    with _agents_lock:
        agents.append(agent)
    save_agents(agents)
    return agent.to_dict()


@app.get("/agents/{agent_id}")
def get_agent(agent_id: str):
    """获取单个 Agent"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")
    return agent.to_dict()


@app.patch("/agents/{agent_id}")
def update_agent(agent_id: str, req: dict):
    """更新 Agent 配置（如 model_choice、max_context、max_output）"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")
    if "model_choice" in req:
        agent.model_choice = req["model_choice"]
    if "role" in req:
        agent.set_role(req["role"])  # BUG-020: role 需显式方法修改
    if "identity_prompt" in req:
        agent.identity_prompt = req["identity_prompt"]
    if "children" in req:
        raw = list(req["children"])
        if agent.id in raw:
            raise HTTPException(400, "Agent 不能将自己的 ID 加入 children（自引用）")
        # 校验所有 child ID 对应已存在的 Agent
        for cid in raw:
            if not find_agent(agents, cid):
                raise HTTPException(400, f"子 Agent '{cid}' 不存在")
        agent.children = raw
    if "max_context" in req:
        try:
            val = int(req["max_context"])
            if val < 256:
                raise ValueError
        except (ValueError, TypeError):
            raise HTTPException(400, "max_context 必须为正整数（≥256）")
        agent.max_context = min(val, MAX_CONTEXT_LIMIT)
    if "max_output" in req:
        try:
            val = int(req["max_output"])
            if val < 64:
                raise ValueError
        except (ValueError, TypeError):
            raise HTTPException(400, "max_output 必须为正整数（≥64）")
        agent.max_output = min(val, MAX_OUTPUT_LIMIT)
    if "reasoning_effort" in req:
        val = req["reasoning_effort"]
        if val not in ("none", "low", "medium", "high"):
            raise HTTPException(400, "reasoning_effort 必须为 none/low/medium/high 之一")
        agent.reasoning_effort = val
    if "show_thinking" in req:
        val = req["show_thinking"]
        if val not in ("on", "off", "auto"):
            raise HTTPException(400, "show_thinking 必须为 on/off/auto 之一")
        agent.show_thinking = val
    if "mode" in req:
        val = req["mode"]
        if val not in ("build", "plan"):
            raise HTTPException(400, "mode 必须为 build/plan 之一")
        agent.mode = val
    if "persona" in req:
        from core.persona import Persona
        try:
            new_persona = Persona(req["persona"])
            agent.persona = new_persona
        except Exception:
            raise HTTPException(400, "persona 数据格式无效")
    # 赋值+持久化在锁内，保持与其它写路径一致
    with _agents_lock:
        save_agents(agents)
    return agent.to_dict()


@app.get("/agents/{agent_id}/persona")
def get_agent_persona(agent_id: str):
    """查看 Agent 人格"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")
    return agent.persona.to_dict()


@app.post("/agents/{agent_id}/split")
def split_agent(agent_id: str, req: AgentSplit):
    """分裂子 Agent"""
    parent = find_agent(agents, agent_id)
    if not parent:
        raise HTTPException(404, "父 Agent 不存在")
    # P1-15: server 端 fork_depth 硬上限校验（CLI /auto 已有，API 直连此前可绕过无限分裂）
    if parent.fork_depth >= Agent.MAX_FORK_DEPTH:
        raise HTTPException(400, f"分裂深度已达上限（MAX_FORK_DEPTH={Agent.MAX_FORK_DEPTH}），禁止继续分裂")
    child = parent.split(
        name=req.name,
        role=req.role,
        model_choice=req.model_choice,
        identity_prompt=req.identity_prompt,
    )
    agents.append(child)
    save_agents(agents)
    return child.to_dict()


def _parse_swarm_analysis(reply: str) -> dict:
    """解析 Swarm 分析回复（A-015：整体 JSON → 正则兜底 → 显式降级标记）。

    返回 {"action", "subtasks", "reason", "parse_ok"}。
    parse_ok=False 表示解析失败已降级为 chat —— 客户端可据此区分
    "模型判定 chat" 与 "解析失败静默降级"（此前两者不可区分，误判无感知）。
    非法 action 归一化为 chat；subtasks 只保留字符串且截断 8 条。"""
    import json, re
    data = None
    parse_ok = False
    try:
        parsed = json.loads(reply or "")
        if isinstance(parsed, dict):
            data, parse_ok = parsed, True
    except (json.JSONDecodeError, TypeError):
        pass

    if data is None:
        # 正则兜底（chat/fork/swarm，容忍前后杂讯与 markdown 代码围栏内嵌）
        m = re.search(r'\{[^{}]*"action"\s*:\s*"(chat|fork|swarm)"[^{}]*\}', reply or "")
        if m:
            try:
                parsed = json.loads(m.group())
                if isinstance(parsed, dict):
                    data, parse_ok = parsed, True
            except json.JSONDecodeError:
                pass

    if data is None:
        data = {}

    action = data.get("action", "chat")
    if action not in ("chat", "fork", "swarm"):
        action, parse_ok = "chat", False

    subtasks = data.get("subtasks", [])
    if not isinstance(subtasks, list):
        subtasks, parse_ok = [], False
    subtasks = [str(s) for s in subtasks if isinstance(s, str)][:8]

    return {
        "action": action,
        "subtasks": subtasks,
        "reason": data.get("reason", ""),
        "parse_ok": parse_ok,
    }


# ── A-049: 编造检测 → 强制工具轮（结构性反幻觉） ─────────────
# 模型（尤其弱模型）面对大量工具时可能"声称完成"而不调用工具（用户多次实测）：
# 检测"生成类请求 + 零工具调用 + 完成态声称" → 自动追加强制工具轮，逼模型真实调用。
_GEN_REQ_HINTS = ("生成", "制作", "创建", "画", "保存", "下载", "写", "做", "设计", "编", "出")
_GEN_TARGET_HINTS = ("图", "视频", "图片", "海报", "logo", "文件", "文案", "报告", "图标", "封面", "头像")

# A-049: 强制轮只注入媒体工具子集（弱模型面对全量 70+ 工具会注意力崩溃，
# 输出非标准 XML 或直接编造；子集注入 + 明确 JSON 格式显著提高真实调用率）
_MEDIA_TOOLS = ("agnes_prompt_build", "agnes_generate_image",
                "agnes_generate_video", "agnes_video_status")

# A-087（漏洞清单 P1-2）：回复失败前缀黑名单——命中任一 → success=False
# （不驱动人格/情绪正反馈）。此前仅 2 个，工具失败/轮次耗尽/截断被当成功入库。
_FAIL_REPLY_PREFIXES = (
    "[API 调用失败", "[API 响应解析失败",
    "[工具调用处理失败", "[工具调用后请求失败", "[工具调用轮次已达上限",
    "[工具调用后无文本回复",
    "[本地模型加载失败", "[本地模型未就绪", "[本地模型调用失败",
    "[Agent 未返回有效回复]", "[委托失败",
    "[流式调用异常", "[流式生成异常",
    "[截断]",
)


def _is_generation_request(message: str) -> bool:
    """用户请求是否属于"生成/制作"类（强制工具轮的先决条件）。"""
    if not message:
        return False
    return (any(h in message for h in _GEN_REQ_HINTS)
            and any(t in message.lower() for t in _GEN_TARGET_HINTS))


# A-085: 图片请求目标词（工具类型匹配检测——图片请求必须调 agnes_generate_image）
# 含内容类词（美女/人像/风景等）——"生成一个美女"无图/视频字样也算图片请求
_IMAGE_REQ_HINTS = ("图", "图片", "照片", "头像", "写真", "壁纸", "插画", "海报", "封面",
                    "logo", "icon", "draw", "image", "photo", "picture", "illustration",
                    "美女", "人像", "模特", "人物", "角色", "风景", "场景", "动物", "静物",
                    "美食", "建筑", "画", "肖像")
_VIDEO_REQ_HINTS = ("视频", "短片", "动画", "剪辑", "录像", "video", "footage", "clip", "movie")
# A-085: 文本类目标词——"生成一个方案/报告/代码"等文档请求不算图片请求（防误伤）
_TEXT_TARGET_HINTS = ("文档", "方案", "报告", "代码", "文案", "文字", "文章", "脚本", "文件",
                      "表格", "提纲", "摘要", "总结", "小说", "故事", "歌词", "论文",
                      "歌", "歌曲", "音乐", "音频", "语音", "配音")


def _is_image_request(message: str) -> bool:
    """用户请求是否以图片/图像为目标（A-085：图片请求调了视频工具 → 工具类型不匹配）。
    判定顺序：明确视频词 → False；图片/内容词 → True；文本目标词 → False；
    无明确目标 → 生成动词 + 非文本 = 默认图片（生图是更常见默认）。"""
    if not message:
        return False
    low = message.lower()
    if any(v in low for v in _VIDEO_REQ_HINTS):
        return False
    if any(h in low for h in _IMAGE_REQ_HINTS):
        return True
    if any(t in low for t in _TEXT_TARGET_HINTS):
        return False
    # 无明确目标：有生成动词 → 默认按图片处理
    return any(h in message for h in _GEN_REQ_HINTS)


def _claims_completion(reply: str) -> bool:
    """回复是否包含"完成态声称"（声称动词 或 证据性描述+本地路径）。
    A-048-R6 后模型会用"文件大小/完整路径"表格规避动词，两者都查。"""
    from core.claims import _CLAIM_VERBS, _EVIDENCE_HINTS, find_unverified_claims
    if not reply:
        return False
    if any(v in reply for v in _CLAIM_VERBS):
        return True
    low = reply.lower()
    if any(h in low for h in _EVIDENCE_HINTS):
        # 证据性描述 + 本地路径（存在性核验命中 or 显式"路径/文件"字样）→ 完成态声称
        if find_unverified_claims(reply):
            return True
        if ("路径" in reply or "文件" in reply) and any(h in low for h in ("字节", "kb", "mb", "大小", "时长")):
            return True
    return False


async def _forced_tool_round(agent, user_message, providers, agents, system_prompt):
    """A-049: 检测到"声称完成但零工具调用"后追加的强制工具轮。
    返回 (reply, tool_events)。模型已实测支持 function calling——但面对 70+ 工具
    会"注意力崩溃"（输出非标准 XML 或编造），故本轮：① 只注入媒体工具子集
    （tools_only）② 用精简 system prompt（不含全量工具清单——完整提示词会列出
    file_list/web_search 等全部工具名，诱导模型胡调绕过子集）。"""
    # A-103（指标④接线）：A-049 强制轮触发计数（供 A/B 影子统计四指标之④）
    try:
        agent.ab_a049_triggers = getattr(agent, "ab_a049_triggers", 0) + 1
    except Exception:
        pass
    from core.agent import IDENTITY_CONSTRAINT, ANTI_HALLUCINATION_PROTOCOL
    media_sys = (
        IDENTITY_CONSTRAINT.replace("{name}", agent.name).replace("{role}", agent.role)
        + "\n\n" + ANTI_HALLUCINATION_PROTOCOL
        + "\n\n【平台能力】本轮可调用工具（生成图片/视频的唯一途径，必须调用）：\n"
        "- agnes_prompt_build：构建生成提示词\n"
        "- agnes_generate_image：生成图片\n"
        "- agnes_generate_video：生成视频\n"
        "- agnes_video_status：查询视频任务状态"
    )
    forced_msg = (
        "【系统强制指令】用户请求生成图片/视频，而你上一条回复声称已完成，但系统检测到"
        "你**没有调用任何工具**——文件不可能凭空生成。\n"
        f"用户请求：{user_message}\n\n"
        "请**立即调用工具真实执行**（本轮只提供媒体工具，用 OpenAI function calling 格式）：\n"
        "- 生图 → agnes_generate_image，参数 {\"prompt\": \"...\", \"size\": \"2K\", \"ratio\": \"1:1\"}\n"
        "- 生视频 → agnes_generate_video，参数 {\"prompt\": \"...\", \"duration\": 5, \"image\": \"图片URL或本地路径\"}\n"
        "- 提示词优化 → agnes_prompt_build\n\n"
        "工具执行后，只转述工具返回的真实结果（本地路径/URL/字节数），"
        "**URL、文件路径必须原样转述，禁止改写、美化或替换其中的域名与品牌词**"
        "（如 agnes-ai.cn 必须保持原样）。"
        "若确实无法执行，如实告诉用户原因。**禁止再次声称完成而不调用工具。**"
    )
    reply = ""
    tool_events: list[dict] = []
    progress_events: list[dict] = []  # A-050-R: 强制轮的进度事件（此前被吞，图生视频无进度条）
    async for chunk in call_llm_stream(
        agent, forced_msg, [], providers, agents, system_prompt=media_sys,
        tools_only=_MEDIA_TOOLS,
    ):
        if chunk["type"] == "tool":
            tool_events.append(chunk)
        elif chunk["type"] == "progress":
            progress_events.append(chunk)
        elif chunk["type"] == "chunk":
            reply += chunk.get("content", "")
        elif chunk["type"] == "done":
            reply = chunk.get("reply", reply) or reply
        elif chunk["type"] == "error":
            reply = reply or chunk.get("message", "")
    return reply, tool_events, progress_events


@app.post("/agents/{agent_id}/chat/analyze")
async def chat_analyze(agent_id: str, req: ChatRequest):
    """分析用户消息是否适合 Swarm 分裂执行"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")

    from core.agent import Agent as AgentCls

    providers = decrypt() or {}
    prompt = AgentCls.build_swarm_analysis_prompt(
        req.message, available_providers=len(providers)
    )
    reply = await call_llm(agent, prompt, [], providers, agents)

    # A-015: 解析失败显式告警（此前静默降级 chat，误判无感知）
    parsed = _parse_swarm_analysis(reply)
    if not parsed["parse_ok"]:
        logging.warning(f"[slime] Swarm 分析回复解析失败，降级为 chat: {str(reply)[:120]!r}")
    return parsed


@app.post("/agents/{agent_id}/chat")
async def chat(agent_id: str, req: ChatRequest):
    """对话接口（返回 reply + metadata），支持子 Agent 委托"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")

    providers = decrypt() or {}

    # 构建含委托能力的 system prompt（告知父 Agent 可用的子 Agent + 广播能力）
    from core.a2a import build_delegation_prompt, parse_delegations, parse_broadcast, strip_delegation_tags
    children_info = []
    for child_id in agent.children:
        child = find_agent(agents, child_id)
        if child:
            children_info.append({"name": child.name, "role": child.role})
    all_agent_names = [a.name for a in agents]
    delegation_prompt = build_delegation_prompt(children_info, all_agent_names)
    custom_sys = agent.get_system_prompt()
    if delegation_prompt:
        custom_sys += delegation_prompt

    # 检查是否有其他 Agent 发来的 A2A 消息（广播或点对点）
    bus = ServerA2ABus.get()
    a2a_context = ""
    if bus:
        pending = await bus.drain_all_async(agent.name)
        if pending:
            parts = []
            for m in pending[-10:]:  # 最近 10 条
                tag = {"request": "委托", "response": "回复", "info": "广播", "alert": "告警"}.get(m.msg_type, m.msg_type)
                parts.append(f"[{tag} 来自 {m.from_agent}]: {m.content[:300]}")
            if parts:
                a2a_context = "## 来自其他 Agent 的消息\n" + "\n".join(parts)

    # 将 A2A 上下文注入用户消息；A-098: 动态命令包装消息注入平台证据
    effective_message = _inject_skill_evidence(req.message)
    if a2a_context:
        effective_message = effective_message + "\n\n" + a2a_context

    result = await call_llm_with_meta(agent, effective_message, req.history, providers, agents, system_prompt=custom_sys)
    reply = (result.get("reply") or "").strip() or "[Agent 未返回有效回复]"

    # ── 委托处理：检测 <DELEGATE> 标记并路由到子 Agent ──
    delegations = parse_delegations(reply)
    delegation_results = []

    # ── 广播处理：检测 <BROADCAST> 标记并发送给所有 Agent ──
    broadcast_msg = parse_broadcast(reply)
    if broadcast_msg and bus:
        await bus.broadcast(agent.name, broadcast_msg, msg_type="info")
        logging.info(f"[slime] {agent.name} 广播了一条消息给 {bus.get_registered_names()}")

    if delegations:
        for d in delegations[:3]:  # 最多处理 3 个委托
            child = next((a for a in agents if a.name.lower() == d["name"].lower()), None)
            if child:
                try:
                    child_result = await call_llm_with_meta(child, d["task"], [], providers, agents)
                    child_reply = child_result.get("reply", "")
                    delegation_results.append({"name": d["name"], "task": d["task"], "result": child_reply})
                    if bus:
                        await bus.send_result(d["name"], agent.name, child_reply[:500])
                except Exception as e:
                    logging.warning(f"[slime] 委托到 {d['name']} 失败: {e}")
                    delegation_results.append({"name": d["name"], "task": d["task"], "result": f"委托失败: {e}"})

        # 有委托结果时，让父 Agent 整合后再回复
        if delegation_results:
            results_text = "\n\n".join(
                f"## {r['name']} 的回复\n任务：{r['task']}\n结果：{r['result']}"
                for r in delegation_results
            )
            followup_msg = (
                f"你刚才将以下子任务委托给了子 Agent，现在结果已经返回。"
                f"请基于这些结果整合成完整的回复给用户：\n\n{results_text}"
            )
            followup_history = list(req.history or [])
            followup_history.append({"role": "assistant", "content": strip_delegation_tags(reply)})
            followup_result = await call_llm_with_meta(
                agent, followup_msg, followup_history, providers, agents,
                system_prompt=custom_sys,
            )
            reply = strip_delegation_tags(followup_result.get("reply", ""))
            result = followup_result  # 用 followup 的 metadata
        else:
            reply = strip_delegation_tags(reply)
    else:
        reply = strip_delegation_tags(reply)

    if not reply:
        reply = "[Agent 未返回有效回复]"

    # API 失败时标记 success=False，保护进化数据
    # A-087（漏洞清单 P1-2）：失败前缀黑名单补全——此前仅 2 个，工具失败/轮次耗尽/
    # 截断等失败回复被当 success=True 入库驱动人格正反馈（编造闭环）
    success = not any(_FAIL_PREFIX in reply for _FAIL_PREFIX in _FAIL_REPLY_PREFIXES)

    # 记录交互 + 持久化到 history.jsonl
    if req.retry:
        history_pop_last(agent.id)
    # A-090（P1-1 学习管线污染）：存储/学习用原文（reply_raw），
    # 品牌过滤只作用于展示（reply）——人格演化/记忆基于模型真实输出而非被替换文本
    raw_reply = result.get("reply_raw") or reply if isinstance(result, dict) else reply
    agent.persona.add_interaction(req.message, raw_reply, success=success)
    history_append(agent.id, req.message, raw_reply, success=success)

    # Soul-Plan 第 5 步：A/B 影子统计记录（best-effort，不阻塞主流程）
    try:
        _record_ab_stats(agent, success=success)
    except Exception:
        pass

    # 后处理：后台派发，不阻塞响应
    _spawn_background(_post_process_chat(agent, req, raw_reply, success, providers))

    return {
        "reply": reply,
        "agent_id": agent.id,
        "model": result.get("model", ""),
        "prompt_tokens": result.get("prompt_tokens", 0),
        "completion_tokens": result.get("completion_tokens", 0),
        "elapsed_ms": result.get("elapsed_ms", 0),
    }


_PRAISE_KEYWORDS = ("谢谢", "感谢", "做得好", "不错", "棒", "太棒", "辛苦", "厉害")


def _inject_skill_evidence(message: str) -> str:
    """A-098: 动态命令（/技能、/MCP）包装消息注入平台证据——
    检测"使用技能 X 处理：..."或"使用 MCP 服务器 X 的工具处理：..."模式，
    自动调 skill_search 并把真实结果注入消息前缀。结构性修复：模型无法忽略平台证据
    （此前弱模型凭对话历史旧列表否认技能存在，见 A-096/A-097 用户实测）。
    未匹配模式返回原文；匹配后无论命中与否都注入结论（命中=指导首段，未命中=明确无）。"""
    import re as _re
    m = _re.match(r"^使用技能 (\S+) 处理[:：]?(.*)$", message, _re.DOTALL)
    if m:
        slug = m.group(1)
        rest = m.group(2).strip()
        try:
            from core.skill_engine import get_registry as _gr
            reg = _gr()
            if not reg.is_loaded:
                reg.load_skills()
            hits = reg.search(slug)
            found = next((h for h in hits if h.get("name") == slug), None)
            if found:
                evidence = (f"[平台证据] 技能 {slug} 已确认存在（skill_search 实时查询命中）。"
                            f"描述：{found.get('description', '')[:200]}\n"
                            f"请使用该技能处理以下请求（技能指导见 skill_lookup）：{rest or slug}")
            else:
                # 名称未精确命中但搜索有近似 → 列出近似；否则明确无
                near = [h.get("name") for h in hits[:3]] if hits else []
                evidence = (f"[平台证据] 技能 {slug} 不存在（skill_search 未命中"
                            + (f"，近似技能：{', '.join(near)}" if near else "") + "）。"
                            f"请如实告知用户，不要编造。请求内容：{rest or slug}")
        except Exception as e:
            evidence = f"[平台证据] 技能 {slug} 查询失败（{e}），请用 skill_search 工具自行核实。请求内容：{rest or slug}"
        return evidence
    m2 = _re.match(r"^使用 MCP 服务器 (\S+) 的工具处理[:：]?(.*)$", message, _re.DOTALL)
    if m2:
        name = m2.group(1)
        rest = m2.group(2).strip()
        try:
            from core.mcp_client import get_mcp_client as _mc
            servers = _mc().status()
            alive = any(isinstance(s, dict) and s.get("name") == name and s.get("running")
                        for s in servers)
            evidence = (f"[平台证据] MCP 服务器 {name} 已配置" + ("且在线。" if alive else "（可能未在线，调用其工具前先核实）。")
                        + f"请使用该服务器的工具处理：{rest or name}")
        except Exception as e:
            evidence = f"[平台证据] MCP 服务器 {name} 查询失败（{e}），请用工具核实。请求：{rest or name}"
        return evidence
    return message


def _record_ab_stats(agent, success: bool) -> None:
    """Soul-Plan 第 5 步：每 Agent A/B 影子统计记录（四指标 + 50 次 dump）。"""
    try:
        import tomllib
        cfg = {}
        toml_path = Path(__file__).parent / "slime.toml"
        if toml_path.exists():
            cfg = tomllib.load(toml_path).get("emotion", {})
        ab_enabled = cfg.get("ab_enabled", True)
        report_after = cfg.get("ab_report_after", 50)
        from core.ab_stats import AbStats
        if not hasattr(_record_ab_stats, "stats"):
            _record_ab_stats.stats = {}
        key = agent.id
        if key not in _record_ab_stats.stats:
            _record_ab_stats.stats[key] = AbStats(key, ab_enabled=ab_enabled, report_after=report_after)
        st = _record_ab_stats.stats[key]
        # A-102（指标②④接线）：工具计数/强制轮计数由环 2 与 A-049 累加到 agent，此处取差值
        cur_total = getattr(agent, "ab_tool_total", 0)
        cur_ok = getattr(agent, "ab_tool_ok", 0)
        cur_a049 = getattr(agent, "ab_a049_triggers", 0)
        prev = getattr(_record_ab_stats, "_prev", {})
        base_total, base_ok, base_a049 = prev.get(key, (0, 0, 0))
        prev[key] = (cur_total, cur_ok, cur_a049)
        win_total = cur_total - base_total
        win_ok = cur_ok - base_ok
        win_a049 = cur_a049 - base_a049
        st.record(success=success, sentiment=getattr(agent.emotion, "valence", 0.0),
                  tool_ok=(win_ok if win_total else None),
                  a049=bool(win_a049))
    except Exception:
        pass


def _detect_praise(message: str, user_sentiment: float) -> bool:
    """praise 信号：关键词命中 且 user_sentiment > 0（双确认，过滤反话讽刺）。"""
    if user_sentiment <= 0 or not message:
        return False
    return any(k in message for k in _PRAISE_KEYWORDS)


def _detect_novelty(agent_id: str, message: str) -> bool:
    """novelty 信号：与最近 5 条历史的 bigram Jaccard 相似度 < 0.15 → 新主题（零嵌入成本）。"""
    # 守卫：空/短确认语（<3 字符）不构成主题判断信息量，直接判非新主题，
    # 避免 "好/嗯/是/好的/收到/继续/谢谢" 等高频短确认语每轮都触发 novelty 的 arousal +0.15 叠加
    if is_short_confirmation(message):
        return False
    try:
        records = history_load(agent_id, limit=6)
    except Exception:
        return False
    prior = [r.get("user", "") for r in records if r.get("user") != message][-5:]
    prior = [p for p in prior if p]
    if not prior:
        return True  # 首次交互视为新主题
    cur = bigrams(message)
    if not cur:
        return False
    sims = []
    for p in prior:
        other = bigrams(p)
        if not other:
            continue
        sims.append(len(cur & other) / len(cur | other))
    return max(sims) < 0.15 if sims else True


async def _post_process_chat(agent, req, reply: str, success: bool, providers: dict):
    """流式对话的后处理：记忆提取 + 演化 + 知识引擎 + 持久化（后台任务，独立于客户端连接）"""
    try:
        # ── 记忆提取 ──
        memory_cfg = _SLIME_CONFIG.get("memory", {})
        trait_signals = []
        user_sentiment = 0.0
        behavior_patterns = []
        if memory_cfg.get("enabled", False) and success:
            try:
                lancedb_cfg = memory_cfg.get("lancedb", {})
                lancedb_enabled = lancedb_cfg.get("enabled", False)
                lancedb_uri = lancedb_cfg.get("uri", "")
                memory = load_memory(agent.id, lancedb_enabled=lancedb_enabled, lancedb_uri=lancedb_uri,
                                     data_dir=memory_cfg.get("dir", ""))

                async def _llm_extract(prompt: str) -> str:
                    return await call_llm(agent, prompt, providers=providers, agent_registry=agents)
                extracted = await extract_memories_from_chat(
                    memory, req.message, reply, success, _llm_extract
                )
                trait_signals = extracted["trait_signals"]
                user_sentiment = extracted["user_sentiment"]
                behavior_patterns = extracted["behavior_patterns"]
            except Exception as e:
                logging.warning(f"[slime] 记忆提取失败: {e}")

        # ── 持久化（演化+知识引擎+save 在同一锁内，防并发覆盖）──
        async with _get_evolve_lock():
            # 演化引擎
            engine = EvolutionEngine.from_dict(agent.evolution) if agent.evolution else EvolutionEngine(agent.id)
            engine.lifecycle = agent.lifecycle
            engine.evolve(agent.persona, {
                "success": success,
                "traits_reinforced": [],
                "traits_weakened": [],
                "trait_signals": trait_signals,
            })
            agent.lifecycle = engine.lifecycle
            agent.evolution = engine.to_dict()

            # 知识引擎：记录 pattern（沉淀的「记录」半环，整理交给 ConsolidationEngine）
            ke = None
            try:
                from core.knowledge import get_knowledge_engine
                ke = get_knowledge_engine(agent.id, data_dir=memory_cfg.get("dir", ""))
                if success:
                    ke.record_pattern("task.chat.success", "task",
                                      f"成功回复: {req.message[:80]}", "low")
                else:
                    ke.record_pattern("task.chat.fail", "task",
                                      f"回复失败: {req.message[:80]}", "medium")
            except Exception as e:
                logging.debug(f"[slime] 知识引擎更新失败: {e}")

            # L3→L2 沉淀：LLM 提取的行为模式 → 行为模式库（BUG-001/019）
            for bp in behavior_patterns:
                agent.behavior.reinforce(
                    scenario=bp["scenario"],
                    steps=bp["steps"],
                    source="llm_extracted",
                    rationale=bp.get("rationale", ""),
                )

            # 情绪更新（BUG-002 + Intelligence 11.2.4 全信号：novelty/violation/praise/failure_type）
            from core.sandbox import get_sandbox_manager
            violation = get_sandbox_manager().pop_violations(agent.id)
            agent.emotion.update(
                success=success,
                user_sentiment=user_sentiment,
                failure_type=None,
                novelty=_detect_novelty(agent.id, req.message),
                violation=violation,
                praise=_detect_praise(req.message, user_sentiment),
            )

            # BUG-024: 沉淀统一走 ConsolidationEngine（知识引擎兜底 + 艾宾浩斯衰减），
            # 触发由 should_consolidate 判断（每 N 次交互），消除内联重复逻辑
            from core.consolidation import ConsolidationEngine
            ce = ConsolidationEngine()
            if ce.should_consolidate(agent):
                ce.consolidate(
                    agent, knowledge_engine=ke,
                    existing_scenarios={bp["scenario"] for bp in behavior_patterns},
                )

            save_agents(agents)

    except asyncio.CancelledError:
        # 用户打断/服务取消：interrupt 三零语义（PAD / consecutive_failures / relational_depth 均不惩罚）
        try:
            agent.emotion.update(success=False, failure_type="interrupt")
            save_agents(agents)
        except Exception:
            pass
        raise  # 遵守 asyncio 取消契约，重新抛出
    except Exception as e:
        logging.warning(f"[slime] 后处理失败: {e}")


@app.post("/agents/{agent_id}/chat/stream")
async def chat_stream(agent_id: str, req: ChatRequest):
    """流式对话接口（SSE），逐块返回内容。

    A-005: 与非流式 /chat 能力对齐 —— 注入委托能力 system prompt、
    排水待处理 A2A 消息、解析 <DELEGATE>/<BROADCAST> 标记并路由。
    终局 done 事件在委托整合完成后才发出（SSE 协议保持单 done 收尾）。"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")

    providers = decrypt() or {}

    # A-005: 构建含委托能力的 system prompt（与 /chat 同源）
    from core.a2a import (
        build_delegation_prompt, parse_delegations, parse_broadcast, strip_delegation_tags,
    )
    children_info = []
    for child_id in agent.children:
        child = find_agent(agents, child_id)
        if child:
            children_info.append({"name": child.name, "role": child.role})
    all_agent_names = [a.name for a in agents]
    delegation_prompt = build_delegation_prompt(children_info, all_agent_names)
    custom_sys = agent.get_system_prompt()
    if delegation_prompt:
        custom_sys += delegation_prompt

    # A-005: 排水待处理 A2A 消息（与 /chat 同源）
    bus = ServerA2ABus.get()
    a2a_context = ""
    if bus:
        pending = await bus.drain_all_async(agent.name)
        if pending:
            parts = []
            for m in pending[-10:]:  # 最近 10 条
                tag = {"request": "委托", "response": "回复", "info": "广播", "alert": "告警"}.get(m.msg_type, m.msg_type)
                parts.append(f"[{tag} 来自 {m.from_agent}]: {m.content[:300]}")
            if parts:
                a2a_context = "## 来自其他 Agent 的消息\n" + "\n".join(parts)
    effective_message = _inject_skill_evidence(req.message)  # A-098: 平台证据注入
    if a2a_context:
        effective_message = effective_message + "\n\n" + a2a_context

    async def _stream_generator():
        full_reply = ""
        model = ""
        prompt_tokens = 0
        completion_tokens = 0
        elapsed_ms = 0
        error_msg = ""
        done_received = False
        held_done: dict | None = None  # A-005: 暂扣 done，委托整合后再发
        tool_event_count = 0  # A-049: 本次请求真实发生的工具调用数
        tool_event_names: list[str] = []  # A-085: 已调用的工具名列表（工具类型匹配检测）

        def _emit(event: dict) -> str:
            import json as _json
            return f"data: {_json.dumps(event, ensure_ascii=False)}\n\n"

        # A-113: SSE 累计响应上限（多工具轮叠加防内存失控；正常使用远低于此）
        _STREAM_MAX_CHARS = 10 * 1024 * 1024

        try:
            async for chunk in call_llm_stream(
                agent, effective_message, req.history, providers, agents,
                system_prompt=custom_sys,
            ):
                if chunk["type"] == "chunk":
                    full_reply += chunk["content"]
                    if len(full_reply) > _STREAM_MAX_CHARS:
                        yield _emit({"type": "error", "message": "响应超限已截断（>10MB）"})
                        return
                    yield _emit(chunk)
                elif chunk["type"] == "tool":
                    tool_event_count += 1
                    tool_event_names.append(str(chunk.get("name", "")))  # A-085
                    yield _emit(chunk)
                elif chunk["type"] == "reasoning":
                    yield _emit(chunk)
                elif chunk["type"] == "progress":  # A-050: 工具进度事件透传
                    yield _emit(chunk)
                elif chunk["type"] == "done":
                    done_received = True
                    # A-090（P1-1 学习管线污染）：full_reply 累积原文（reply_raw），
                    # 存储/学习用原文；展示走逐 chunk（已过滤），不依赖 full_reply
                    full_reply = chunk.get("reply_raw", chunk["reply"])
                    held_done = dict(chunk)  # 暂扣，委托处理后再发
                elif chunk["type"] == "error":
                    error_msg = chunk["message"]
                    full_reply = error_msg
                    yield _emit(chunk)

            # ── A-049/A-085: 编造检测 → 强制工具轮（结构性反幻觉）──
            # A-049: 生成类请求 + 零工具调用 + 完成态声称 → 模型在编造。
            # A-085: 图片请求但调了**错误类型**工具（如调了视频而非图片，再把视频结果
            # 编造成"图片已保存 xxx.png"）→ 同样触发强制轮（强制注入 image 工具逼真实生成）。
            _media_mismatch = False
            if tool_event_names and _is_generation_request(req.message):
                _img = "agnes_generate_image" in tool_event_names
                _vid = "agnes_generate_video" in tool_event_names
                if _is_image_request(req.message) and not _img and not any(
                        n == "agnes_prompt_build" for n in tool_event_names):
                    _media_mismatch = True
            if (done_received and held_done is not None
                    and _is_generation_request(req.message)
                    and (tool_event_count == 0 or _media_mismatch)
                    and _claims_completion(full_reply)):
                forced_reply, forced_events, forced_progress = await _forced_tool_round(
                    agent, req.message, providers, agents, system_prompt=custom_sys,
                )
                if forced_events or forced_progress:
                    # 强制轮真实执行 → 进度事件（A-050-R：此前被吞）与工具事件流式输出
                    for ev in forced_progress:
                        yield _emit(ev)
                    for ev in forced_events:
                        yield _emit(ev)
                    full_reply = forced_reply or full_reply
                    held_done["reply"] = full_reply
                    logging.info(
                        f"[slime] A-049 强制工具轮拦截编造: {agent.name} "
                        f"零工具调用却声称完成，强制调用 {len(forced_events)} 个工具"
                    )
                else:
                    # 仍不调工具 → 追加显式系统警告（结果不可信）
                    full_reply += (
                        "\n\n> ⚠ 系统提示：本次请求检测到你声称完成但未调用任何工具，"
                        "上述结果不可信，文件并未真实生成。"
                    )
                    held_done["reply"] = full_reply

            # ── A-005: 委托/广播处理（对齐 /chat）──
            if done_received and held_done is not None:
                first_reply = full_reply

                broadcast_msg = parse_broadcast(first_reply)
                if broadcast_msg and bus:
                    await bus.broadcast(agent.name, broadcast_msg, msg_type="info")
                    logging.info(f"[slime] {agent.name} 广播了一条消息给 {bus.get_registered_names()}")

                delegations = parse_delegations(first_reply)
                delegation_results = []
                if delegations:
                    # A-045: 委托执行移入后台任务 + 事件队列 —— 委托期间（生图/生视频
                    # 等工具可达数分钟）SSE 原本完全静默，客户端读超时（实测 2m21s
                    # "timed out"）掐断整条流。现每隔 _HEARTBEAT_INTERVAL 发心跳。
                    event_q: asyncio.Queue = asyncio.Queue()

                    async def _delegation_worker():
                        for d in delegations[:3]:  # 最多处理 3 个委托
                            child = next((a for a in agents if a.name.lower() == d["name"].lower()), None)
                            if not child:
                                continue
                            try:
                                child_result = await call_llm_with_meta(child, d["task"], [], providers, agents)
                                child_reply = child_result.get("reply", "")
                                delegation_results.append({"name": d["name"], "task": d["task"], "result": child_reply})
                                if bus:
                                    await bus.send_result(d["name"], agent.name, child_reply[:500])
                                await event_q.put({"type": "tool", "name": f"delegate:{d['name']}",
                                                   "args": d["task"], "result": child_reply[:200]})
                            except Exception as e:
                                logging.warning(f"[slime] 委托到 {d['name']} 失败: {e}")
                                delegation_results.append({"name": d["name"], "task": d["task"], "result": f"委托失败: {e}"})
                                await event_q.put({"type": "tool", "name": f"delegate:{d['name']}",
                                                   "args": d["task"], "result": f"委托失败: {e}"})
                        await event_q.put(None)  # 哨兵：委托全部完成

                    worker = asyncio.create_task(_delegation_worker())
                    while True:
                        try:
                            evt = await asyncio.wait_for(event_q.get(), timeout=_HEARTBEAT_INTERVAL)
                        except asyncio.TimeoutError:
                            yield _emit({"type": "heartbeat",
                                         "content": f"委托执行中（已处理 {len(delegations[:3])} 项委托）..."})
                            continue
                        if evt is None:
                            break
                        yield _emit(evt)
                    await worker

                if delegation_results:
                    # 有委托结果：父 Agent 流式整合后收尾（单 done 终局）
                    results_text = "\n\n".join(
                        f"## {r['name']} 的回复\n任务：{r['task']}\n结果：{r['result']}"
                        for r in delegation_results
                    )
                    followup_msg = (
                        f"你刚才将以下子任务委托给了子 Agent，现在结果已经返回。"
                        f"请基于这些结果整合成完整的回复给用户：\n\n{results_text}"
                    )
                    followup_history = list(req.history or [])
                    followup_history.append({"role": "assistant", "content": strip_delegation_tags(first_reply)})
                    full_reply = ""
                    async for fchunk in call_llm_stream(
                        agent, followup_msg, followup_history, providers, agents,
                        system_prompt=custom_sys,
                    ):
                        if fchunk["type"] == "chunk":
                            full_reply += fchunk["content"]
                            yield _emit(fchunk)
                        elif fchunk["type"] in ("reasoning", "tool"):
                            yield _emit(fchunk)
                        elif fchunk["type"] == "done":
                            full_reply = fchunk["reply"]
                            model = fchunk.get("model", held_done.get("model", ""))
                            prompt_tokens = fchunk.get("prompt_tokens", 0)
                            completion_tokens = fchunk.get("completion_tokens", 0)
                            elapsed_ms = fchunk.get("elapsed_ms", 0)
                            yield _emit({"type": "done", "reply": full_reply, "model": model,
                                         "prompt_tokens": prompt_tokens,
                                         "completion_tokens": completion_tokens,
                                         "elapsed_ms": elapsed_ms})
                        elif fchunk["type"] == "error":
                            error_msg = fchunk["message"]
                            yield _emit(fchunk)
                else:
                    full_reply = strip_delegation_tags(first_reply)
                    held_done["reply"] = full_reply
                    model = held_done.get("model", "")
                    prompt_tokens = held_done.get("prompt_tokens", 0)
                    completion_tokens = held_done.get("completion_tokens", 0)
                    elapsed_ms = held_done.get("elapsed_ms", 0)
                    yield _emit(held_done)
        except Exception as _stream_exc:
            # S2: 显式捕获异常为 error chunk，避免 finally return 吞异常
            error_msg = f"[流式生成异常: {_stream_exc}]"
            yield _emit({"type": "error", "message": error_msg})
        finally:
            # 后处理：无论客户端是否断开，确保记录交互、历史、记忆、演化
            # N11-P2-2: 不用 finally 内 return（会吞 BaseException），改用条件判断
            if done_received or full_reply or error_msg:
                reply = full_reply or error_msg
                # N12-2: 流未完成（客户端中途断开）时标记截断，避免不完整回复污染历史
                if full_reply and not done_received and not error_msg:
                    reply = full_reply + "\n[截断]"
                # A-087（漏洞清单 P1-2）：失败前缀黑名单统一（含 [截断] 强制 False）
                success = not any(_FAIL_PREFIX in reply for _FAIL_PREFIX in _FAIL_REPLY_PREFIXES)

                # 同步操作留 finally（瞬间完成，不受断连影响）
                if req.retry:
                    history_pop_last(agent.id)
                agent.persona.add_interaction(req.message, reply, success=success)
                history_append(agent.id, req.message, reply, success=success)

                # 异步后处理后台派发，独立于客户端连接生命周期
                _spawn_background(_post_process_chat(
                    agent, req, reply, success, providers
                ))

    return StreamingResponse(
        _stream_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/agents/{agent_id}/history")
def get_history(agent_id: str, limit: int = 200):
    """获取 Agent 对话历史（从 history.jsonl）"""
    limit = max(1, min(limit, 1000))  # N11-P2-3: 上限 1000，防内存耗尽
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")
    records = history_load(agent_id=agent_id, limit=limit)
    # A-090（P1-1）：history 存原文（模型真实输出），回显时应用品牌过滤（展示层）
    from core.llm import _apply_filter
    for rec in records:
        if isinstance(rec, dict) and rec.get("ai"):
            rec["ai"] = _apply_filter(str(rec["ai"]), agent)
    return records


@app.delete("/agents/{agent_id}")
def delete_agent(agent_id: str):
    """删除 Agent 及其子 Agent（含孤立数据清理）"""
    global agents
    # N11-P2-4: find_agent + 递归收集 + 删除 + save 全程锁内，防并发修改
    with _agents_lock:
        agent = find_agent(agents, agent_id)
        if not agent:
            raise HTTPException(404, "Agent 不存在")

        # 递归收集所有子 Agent ID
        to_delete = set()

        def collect_ids(a: Agent, visited: set = None):
            if visited is None:
                visited = set()
            if a.id in visited:
                return
            visited.add(a.id)
            to_delete.add(a.id)
            for child_id in a.children:
                child = find_agent(agents, child_id)
                if child:
                    collect_ids(child, visited)

        collect_ids(agent)
        agents = [a for a in agents if a.id not in to_delete]
        # A-034: 清理其余 Agent 的悬空 children 引用 —— 否则父 Agent 的 children
        # 残留已删 id，委托提示词列出幽灵子 Agent，委托时静默跳过
        for a in agents:
            a.children = [c for c in a.children if c not in to_delete]
        save_agents(agents)

    # 清理孤立数据：memory / LanceDB / history 记录（文件操作慢，锁外执行）
    import shutil
    for aid in to_delete:
        # 清理 data/ 目录（LanceDB 等）
        mem_dir = Path(__file__).parent / "data" / aid
        if mem_dir.exists():
            try:
                shutil.rmtree(str(mem_dir), ignore_errors=True)
            except Exception:
                pass
        # 清理 Knowledge/ 目录（memory.json / knowledge.json / rules 等）
        knowledge_dir = Path(__file__).parent / "Knowledge" / "Agent Memory" / aid
        if knowledge_dir.exists():
            try:
                shutil.rmtree(str(knowledge_dir), ignore_errors=True)
            except Exception:
                pass
        # 清理 history.jsonl 中该 Agent 的记录（A-025: 走 core.history 锁内实现，防并发丢记录）
        from core.history import remove_agent as history_remove_agent
        removed = history_remove_agent(aid)
        if removed:
            logging.info(f"[slime] 已从历史中移除 Agent {aid} 的 {removed} 条记录")

    return {"deleted": list(to_delete)}


# ── 记忆系统（Phase 2）────────────────────────────────────

@app.get("/agents/{agent_id}/memory")
def get_agent_memory(agent_id: str):
    """获取 Agent 成长记忆"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")
    memory_cfg = _SLIME_CONFIG.get("memory", {})
    lancedb_cfg = memory_cfg.get("lancedb", {}) if isinstance(memory_cfg.get("lancedb"), dict) else {}
    memory = load_memory(agent_id, lancedb_enabled=lancedb_cfg.get("enabled", False), lancedb_uri=lancedb_cfg.get("uri", ""), data_dir=memory_cfg.get("dir", ""))
    return memory.to_dict()


@app.post("/agents/{agent_id}/memory")
def update_agent_memory(agent_id: str, req: dict):
    """手动更新 Agent 记忆"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")
    memory_cfg = _SLIME_CONFIG.get("memory", {})
    lancedb_cfg = memory_cfg.get("lancedb", {}) if isinstance(memory_cfg.get("lancedb"), dict) else {}
    memory = load_memory(agent_id, lancedb_enabled=lancedb_cfg.get("enabled", False), lancedb_uri=lancedb_cfg.get("uri", ""), data_dir=memory_cfg.get("dir", ""))
    if "fact" in req:
        memory.add_fact(req["fact"])
    if "preference" in req and "value" in req:
        memory.add_preference(req["preference"], req["value"])
    if "skill" in req:
        memory.add_skill(req["skill"])
    if "lesson" in req:
        memory.add_lesson(req["lesson"], req.get("success", True))
    return memory.to_dict()


@app.post("/agents/{agent_id}/memory/recall")
def recall_agent_memory(agent_id: str, req: dict):
    """LanceDB 向量检索相关记忆"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")
    query = str(req.get("query", "")).strip()
    if not query:
        raise HTTPException(400, "query 不能为空")
    try:
        top_k = int(req.get("top_k", 5))
    except (ValueError, TypeError):
        raise HTTPException(400, "top_k 必须为整数")
    if top_k < 1:
        raise HTTPException(400, "top_k 必须为正整数")
    memory_cfg = _SLIME_CONFIG.get("memory", {})
    lancedb_cfg = memory_cfg.get("lancedb", {}) if isinstance(memory_cfg.get("lancedb"), dict) else {}
    memory = load_memory(agent_id, lancedb_enabled=lancedb_cfg.get("enabled", False), lancedb_uri=lancedb_cfg.get("uri", ""), data_dir=memory_cfg.get("dir", ""))
    results = memory.recall(query, top_k=top_k)
    return {"query": query, "top_k": top_k, "results": results}


async def _post_process_swarm(agent, task: str, summary: str,
                              results: list[dict], providers: dict) -> dict:
    """Swarm 任务后处理（A-031）：让主 Agent 从 Swarm 经验中成长。

    复用 _post_process_chat 的同一套管线（记忆提取→演化→知识 Pattern→行为沉淀→情绪），
    输入侧为 Swarm 任务与合并总结；success = 无失败子任务。"""
    memory_cfg = _SLIME_CONFIG.get("memory", {})
    trait_signals = []
    user_sentiment = 0.0
    behavior_patterns = []
    success = bool(results) and all(
        r.get("state") in ("done",) for r in results
    )

    if memory_cfg.get("enabled", False) and success:
        try:
            lancedb_cfg = memory_cfg.get("lancedb", {})
            memory = load_memory(agent.id,
                                 lancedb_enabled=lancedb_cfg.get("enabled", False),
                                 lancedb_uri=lancedb_cfg.get("uri", ""),
                                 data_dir=memory_cfg.get("dir", ""))

            async def _llm_extract(prompt: str) -> str:
                return await call_llm(agent, prompt, providers=providers, agent_registry=agents)
            extracted = await extract_memories_from_chat(
                memory, task, summary, success, _llm_extract
            )
            trait_signals = extracted["trait_signals"]
            user_sentiment = extracted["user_sentiment"]
            behavior_patterns = extracted["behavior_patterns"]
        except Exception as e:
            logging.warning(f"[slime] Swarm 记忆提取失败: {e}")

    async with _get_evolve_lock():
        engine = EvolutionEngine.from_dict(agent.evolution) if agent.evolution else EvolutionEngine(agent.id)
        engine.lifecycle = agent.lifecycle
        engine.evolve(agent.persona, {
            "success": success,
            "traits_reinforced": [],
            "traits_weakened": [],
            "trait_signals": trait_signals,
        })
        agent.lifecycle = engine.lifecycle
        agent.evolution = engine.to_dict()

        ke = None
        try:
            from core.knowledge import get_knowledge_engine
            ke = get_knowledge_engine(agent.id, data_dir=memory_cfg.get("dir", ""))
            if success:
                ke.record_pattern("task.swarm.success", "task",
                                  f"Swarm 任务成功: {task[:80]}", "low")
            else:
                failed = sum(1 for r in results if r.get("state") != "done")
                ke.record_pattern("task.swarm.fail", "task",
                                  f"Swarm 任务 {failed} 个子任务失败: {task[:80]}", "medium")
        except Exception as e:
            logging.debug(f"[slime] Swarm 知识引擎更新失败: {e}")

        for bp in behavior_patterns:
            agent.behavior.reinforce(
                scenario=bp["scenario"], steps=bp["steps"],
                source="swarm_extracted", rationale=bp.get("rationale", ""),
            )

        from core.sandbox import get_sandbox_manager
        violation = get_sandbox_manager().pop_violations(agent.id)
        agent.emotion.update(
            success=success,
            user_sentiment=user_sentiment,
            failure_type=None,
            novelty=_detect_novelty(agent.id, task),
            violation=violation,
            praise=False,
        )

        from core.consolidation import ConsolidationEngine
        ce = ConsolidationEngine()
        if ce.should_consolidate(agent):
            ce.consolidate(
                agent, knowledge_engine=ke,
                existing_scenarios={bp["scenario"] for bp in behavior_patterns},
            )

        save_agents(agents)

    return {
        "success": success,
        "memory_count": {
            "facts": 0, "traits": len(trait_signals),
        },
        "lifecycle": agent.lifecycle.value,
    }


@app.post("/agents/{agent_id}/swarm/report")
async def swarm_report(agent_id: str, req: dict):
    """Swarm 任务完成上报（A-031）：主 Agent 沉淀本次 Swarm 经验（记忆/演化/行为）。
    CLI 在 Swarm 执行后调用；写 Agent 状态一律走本 API（promote 铁律）。"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")
    task = str(req.get("task", "")).strip()
    summary = str(req.get("summary", "")).strip()
    if not task or not summary:
        raise HTTPException(400, "task 与 summary 不能为空")
    results = req.get("results", [])
    if not isinstance(results, list) or len(results) > 16:
        raise HTTPException(400, "results 必须是不超过 16 项的列表")
    clean_results = []
    for r in results:
        if not isinstance(r, dict):
            continue
        state = str(r.get("state", ""))
        if state not in ("done", "failed"):
            state = "failed"
        clean_results.append({
            "name": str(r.get("name", ""))[:64],
            "state": state,
            "result": str(r.get("result", ""))[:2000],
            "error": str(r.get("error", ""))[:500],
        })
    providers = decrypt() or {}
    report = await _post_process_swarm(agent, task, summary, clean_results, providers)
    return {"ok": True, **report}


# ── 上下文压缩配置（Phase 2）───────────────────────────────

@app.get("/agents/{agent_id}/context")
def get_context_config(agent_id: str):
    """获取 Agent 上下文压缩配置"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")
    return {
        "context_config": agent.context_config,
        "compression_stats": ContextCompressor(agent.context_config).get_compression_stats(),
    }


@app.patch("/agents/{agent_id}/context")
def update_context_config(agent_id: str, req: dict):
    """更新 Agent 上下文压缩配置"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")
    temp = dict(agent.context_config)
    for key in ("head", "tail", "window"):
        if key in req:
            try:
                val = int(req[key])
            except (ValueError, TypeError):
                raise HTTPException(400, f"{key} 必须为整数")
            if val < 1:
                raise HTTPException(400, f"{key} 必须为正整数（≥1）")
            temp[key] = val
    # 校验 head + tail ≤ window
    if temp["head"] + temp["tail"] > temp["window"]:
        raise HTTPException(400, f"head({temp['head']}) + tail({temp['tail']}) 不能超过 window({temp['window']})")
    agent.context_config = temp
    save_agents(agents)
    return agent.context_config


@app.post("/agents/{agent_id}/compress")
async def compress_history(agent_id: str, req: dict):
    """手动触发上下文压缩，返回压缩前后的消息数"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")

    history = req.get("history", [])
    if not isinstance(history, list):
        raise HTTPException(400, "history 必须为列表")
    if not history:
        return {"before": 0, "after": 0, "compressed": False, "message": "无对话历史"}

    from core.context import ContextCompressor
    compressor = ContextCompressor(agent.context_config)

    before = len(history)
    needs = compressor.needs_compression(history)

    if not needs:
        return {
            "before": before,
            "after": before,
            "compressed": False,
            "message": f"当前 {before} 条对话未超过阈值 {compressor.config['window']}，无需压缩",
        }

    # 传入 LLM 摘要函数
    providers = decrypt() or {}

    async def _summary_fn(prompt: str) -> str:
        try:
            return await call_llm(agent, prompt, providers=providers, agent_registry=agents)
        except Exception:
            return "省略了部分对话"

    compressed = await compressor.compress_async(history, summary_fn=_summary_fn)
    after = len(compressed)

    return {
        "before": before,
        "after": after,
        "compressed": True,
        "message": f"已压缩 {before} → {after} 条（摘要中间 {before - after + 1} 条）",
        "history": compressed,
    }


# ── 演化引擎（Phase 2）─────────────────────────────────────

@app.get("/agents/{agent_id}/evolve")
def get_evolve_stats(agent_id: str):
    """获取 Agent 演化统计"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")
    # 从 agent.evolution 恢复，而非新建空引擎
    engine = EvolutionEngine.from_dict(agent.evolution) if agent.evolution else EvolutionEngine(agent_id)
    engine.lifecycle = agent.lifecycle
    return engine.stats


@app.post("/agents/{agent_id}/evolve")
def trigger_evolve(agent_id: str, req: dict):
    """触发 Agent 演化"""
    agent = find_agent(agents, agent_id)
    if not agent:
        raise HTTPException(404, "Agent 不存在")
    # 从 agent.evolution 恢复
    engine = EvolutionEngine.from_dict(agent.evolution) if agent.evolution else EvolutionEngine(agent_id)
    engine.lifecycle = agent.lifecycle
    engine.evolve(agent.persona, req)
    # 同步回 agent
    agent.lifecycle = engine.lifecycle
    agent.evolution = engine.to_dict()
    with _agents_lock:
        save_agents(agents)
    return {
        "lifecycle": agent.lifecycle.value,
        "stats": engine.stats,
    }


# ── 技能系统（Phase 3）────────────────────────────────────

@app.get("/skills")
def list_skills():
    """列出所有已加载的技能"""
    from core.skill_engine import get_registry as get_skill_registry
    skill_reg = get_skill_registry()
    if not skill_reg._loaded:
        skill_reg.load_skills()
    return {"skills": [s.to_llm_schema() for s in skill_reg._skills.values()]}


@app.post("/skills/load")
def reload_skills():
    """重新加载所有技能（热更新）。A-004: 统一走 load_all_skills 注册 skill_search/skill_lookup。"""
    from core.skill_engine import load_all_skills
    loaded = load_all_skills()
    return {"loaded": loaded, "count": len(loaded)}


# ── 工具注册表（Phase 2）───────────────────────────────────

@app.get("/tools")
def list_tools():
    """列出所有注册的工具（LLM 统一 Schema）"""
    return get_registry().list_tools()


@app.post("/tools/call")
async def call_tool(req: dict):
    """调用工具（带沙箱保护：agent_id 必填，权限校验 + 审计）"""
    name = req.get("name", "")
    args = req.get("args", {})
    agent_id = req.get("agent_id", "")
    if not name:
        raise HTTPException(400, "缺少 tool name")
    if not agent_id:
        raise HTTPException(400, "缺少 agent_id（工具调用必须归属某个 Agent）")
    if not isinstance(args, dict):
        raise HTTPException(400, "args 必须为对象")

    from core.sandbox import get_sandbox_manager
    manager = get_sandbox_manager()
    from tools.registry import get_registry
    tool = get_registry().get(name)
    # N11-P1-3: 工具不存在时明确 404，不暴露存在性也不调用
    if tool is None:
        raise HTTPException(404, f"工具 '{name}' 未注册")

    # 计算所需最高权限等级（read=0, write=2, terminal=3, network=4）
    perm_map = {"read": 0, "write": 2, "terminal": 3, "network": 4}
    if tool.permissions:
        level = max(perm_map.get(p, 2) for p in tool.permissions)
    else:
        level = 0  # 无权限声明 → 只读级
    result = manager.check_permission(agent_id, name, str(args), level=level)
    if not result.allowed:
        # A-089（漏洞清单 P1-8 覆盖补全）：/tools/call 直连路径被拒时也记 violation + 审计
        # （此前仅 LLM 工具循环路径有 record_violation，API 直连被拒零审计）
        manager.record_violation(agent_id)
        raise HTTPException(403, f"权限不足: {result.reason}")
    # 通过后记录授权与审计（与 LLM 工具调用路径一致）
    manager.grant_permission(agent_id, name, str(args), level=level, granted_by="user")

    result = await get_registry().call_tool(name, args)
    return {"result": result}


# ── 社交接入（Phase 2）─────────────────────────────────────

@app.post("/social/webhook")
async def social_webhook(req: dict):
    """企业微信 webhook 接收（绑定 agent_id 处理消息）"""
    agent_id = req.get("agent_id", "")
    agent = find_agent(agents, agent_id) if agent_id else None

    # 读取社交配置
    social_cfg = _SLIME_CONFIG.get("social", {})
    webhook_url = social_cfg.get("wechat_webhook_url", "")
    verify_token = social_cfg.get("wechat_verify_token", "")

    providers = decrypt() or {}
    adapter = WeChatWorkAdapter(
        webhook_url=webhook_url,
        agent=agent,
        providers=providers,
        agent_registry=agents,
        verify_token=verify_token,
    )

    # 签名校验：区分 URL 验证（GET echostr）与消息验签（POST msg_signature）
    has_echostr = "echostr" in req
    has_sig = all(k in req for k in ("msg_signature", "timestamp", "nonce"))
    if has_echostr:
        # P1-19: URL 验证也必须先验签（含 echostr 的签名）再回显
        if not verify_token:
            raise HTTPException(503, "未配置 wechat_verify_token，webhook 已禁用")
        if has_sig:
            if not await adapter.verify(req):
                raise HTTPException(403, "签名校验失败")
        else:
            raise HTTPException(400, "缺少签名参数")
        return req["echostr"]
    # N11-P1-1: verify_token 未配置时显式拒绝，防未认证请求触发 LLM 调用
    if not verify_token:
        raise HTTPException(503, "未配置 wechat_verify_token，webhook 已禁用")
    if has_sig:
        if not await adapter.verify(req):
            raise HTTPException(403, "签名校验失败")
    else:
        raise HTTPException(400, "缺少签名参数")

    message = {
        "chat_id": req.get("chat_id", ""),
        "user_id": req.get("user_id", ""),
        "content": req.get("content", ""),
        "msg_type": req.get("msg_type", "text"),
    }
    reply = await adapter.receive(message)
    if reply and message["chat_id"]:
        await adapter.send(message["chat_id"], reply)
    return {"status": "ok", "reply": reply}


@app.post("/social/wechat/personal/webhook")
async def personal_wechat_webhook(req: dict):
    """个人微信 webhook 接收（N10-L2: WeChatAdapter 路由激活）"""
    agent_id = req.get("agent_id", "")
    agent = find_agent(agents, agent_id) if agent_id else None

    social_cfg = _SLIME_CONFIG.get("social", {})
    providers = decrypt() or {}

    from social.wechat import WeChatAdapter
    adapter = WeChatAdapter(
        bridge_url=social_cfg.get("wechat_bridge_url", ""),
        bridge_token=social_cfg.get("wechat_bridge_token", ""),
        verify_token=social_cfg.get("wechat_verify_token", ""),
        agent=agent,
        providers=providers,
        agent_registry=agents,
    )

    # 签名校验（P1-19: echostr 分支也必须先验签再回显）
    has_echostr = "echostr" in req
    has_sig = all(k in req for k in ("signature", "timestamp", "nonce"))
    if has_echostr:
        if has_sig:
            if not await adapter.verify(req):
                raise HTTPException(403, "签名校验失败")
        else:
            raise HTTPException(403, "缺少签名")
        return req["echostr"]  # URL 验证
    if has_sig:
        if not await adapter.verify(req):
            raise HTTPException(403, "签名校验失败")
    else:
        # N11-P1-2: 既无签名也无 echostr → 拒绝，防未签名请求被直接处理
        raise HTTPException(403, "缺少签名")

    return await adapter.handle_webhook(req)


# ── 全局配置管理 ──────────────────────────────────────────

@app.get("/config/global")
def get_global_config():
    """获取全局默认配置"""
    return get_defaults()


@app.patch("/config/global")
def update_global_config(req: dict):
    """更新全局配置，并同步所有在册 Agent"""
    cfg = load_global_config()
    if "max_context" in req:
        try:
            val = int(req["max_context"])
            if val < 256:
                raise ValueError
        except (ValueError, TypeError):
            raise HTTPException(400, "max_context 必须为正整数（≥256）")
        cfg["max_context"] = min(val, MAX_CONTEXT_LIMIT)
    if "max_output" in req:
        try:
            val = int(req["max_output"])
            if val < 64:
                raise ValueError
        except (ValueError, TypeError):
            raise HTTPException(400, "max_output 必须为正整数（≥64）")
        cfg["max_output"] = min(val, MAX_OUTPUT_LIMIT)
    save_global_config(cfg)

    # 同步所有在册 Agent（只升级不降级）
    for agent in agents:
        agent.max_context = max(agent.max_context, cfg["max_context"])
        agent.max_output = max(agent.max_output, cfg["max_output"])
    save_agents(agents)

    return {"status": "ok", "config": cfg}


# ── Provider 管理 ──────────────────────────────────────────

@app.post("/providers")
def save_provider(req: ProviderSave):
    """保存 provider（加密存储）。A-024: 输入校验 —— key 字符集/长度、api_base 协议、数值钳制。"""
    import re as _re
    key = (req.key or "").strip()
    if not key or not _re.match(r"^[A-Za-z0-9_.\-]{1,64}$", key):
        raise HTTPException(400, "Provider key 只能包含字母/数字/_.- 且不超过 64 字符")
    base = (req.api_base or "").strip()
    if not base.startswith(("http://", "https://")):
        raise HTTPException(400, "api_base 必须是 http:// 或 https:// URL")
    providers = decrypt() or {}
    providers[key] = {
        "api_base": base,
        "api_key": (req.api_key or "").strip(),
        "model": (req.model or "").strip(),
        # 数值钳制：负数/极端值会污染上下文预算计算（llm.py 预算、handoff 30% 等）
        "max_context": max(0, int(req.max_context or 0)),
        "max_output": max(0, int(req.max_output or 0)),
    }
    encrypt(providers)
    return {"status": "ok", "key": key}


@app.get("/providers")
def list_providers():
    """列出 provider（不返回 api_key）"""
    providers = decrypt() or {}
    safe = {}
    for key, cfg in providers.items():
        if isinstance(cfg, dict):
            safe[key] = {
                "api_base": cfg.get("api_base", ""),
                "model": cfg.get("model", ""),
                "max_context": cfg.get("max_context", 0),
                "max_output": cfg.get("max_output", 0),
            }
        else:
            # 兼容旧格式/占位数据
            safe[key] = {
                "api_base": str(cfg),
                "model": "",
                "max_context": 0,
                "max_output": 0,
            }
    return safe


@app.delete("/providers/{key}")
def delete_provider(key: str):
    """删除 provider"""
    providers = decrypt() or {}
    if key in providers:
        del providers[key]
        encrypt(providers)
        return {"status": "deleted", "key": key}
    raise HTTPException(404, "Provider 不存在")


# ── 本地模型管理路由 ──────────────────────────────────────

@app.get("/model-servers")
def list_model_servers():
    """列出所有本地模型实例状态"""
    from core.model_server import get_model_server
    mgr = get_model_server()
    if not mgr:
        return []
    return mgr.status()


@app.post("/model-servers/{role}/start")
async def start_model_server(role: str):
    """手动拉起本地模型实例"""
    if role not in ("chat",):
        raise HTTPException(400, f"不支持的角色: {role}（仅支持 chat）")
    from core.model_server import get_model_server
    mgr = get_model_server()
    if not mgr:
        raise HTTPException(503, "本地模型管理器未初始化（slime.toml 中缺少 [model_server] 配置）")
    result = await mgr.ensure(role)
    if result.get("ok"):
        return result
    raise HTTPException(503, result.get("error", "启动失败"))


@app.post("/model-servers/{role}/stop")
def stop_model_server(role: str):
    """手动停止本地模型实例"""
    from core.model_server import get_model_server
    mgr = get_model_server()
    if not mgr:
        raise HTTPException(503, "本地模型管理器未初始化")
    result = mgr.release(role)
    if result.get("ok"):
        return result
    raise HTTPException(400, result.get("error", "停止失败"))


# ── MCP 管理路由 ──────────────────────────────────────────

@app.get("/mcp/servers")
def list_mcp_servers():
    """列出所有 MCP Server 状态"""
    return get_mcp_client().status()


@app.post("/mcp/servers/{name}/start")
async def start_mcp_server(name: str):
    """启动指定 MCP Server"""
    mcp = get_mcp_client()
    ok = await mcp.start_one(name)
    if ok:
        return {"ok": True, "name": name}
    raise HTTPException(503, f"MCP Server '{name}' 启动失败或不存在")


@app.post("/mcp/servers/{name}/stop")
async def stop_mcp_server(name: str):
    """停止指定 MCP Server"""
    mcp = get_mcp_client()
    ok = await mcp.stop_one(name)
    if ok:
        return {"ok": True, "name": name}
    raise HTTPException(404, f"MCP Server '{name}' 未找到或未运行")


# ── 入口 ──────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=SLIME_PORT, log_level="info")
