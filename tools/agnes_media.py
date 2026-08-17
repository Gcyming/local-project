"""
Agnes 同厂媒体生成工具集（A-048 重写：反幻觉强化版）

核心设计目标：**消灭模型的编造空间**——
1. 工具返回即唯一事实来源：成功时给出**真实本地路径 + 真实文件大小（字节数）**；
2. 下载失败时明确返回"已生成但未保存到本地"，**绝不出现"成功/完成"字样**（弱模型
   此前会据此脑补本地路径与文件大小——用户实测：声称 2,920,440 字节已保存，目录为空）；
3. 视频未完成时明确"未完成 + 任务 ID + 进度"，禁止任何完成态表述；
4. 所有失败统一 `[错误]` 前缀（反幻觉协议识别信号），模型必须如实转述；
5. 配套 `agnes_prompt_build`：规则式提示词构建（不调 LLM，确定性输出），
   替代原 reality-prompts skill；附 FACE_STANDARD 浓缩画质段。

工具清单：
- agnes_prompt_build：中文/英文需求 → 可直接使用的生成 prompt + 参数建议
- agnes_generate_image：文生图 / 图生图（本地图片自动 base64）
- agnes_generate_video：文生视频 / 图生视频（提交 + 有限轮询，最长约 5 分钟）
- agnes_video_status：查询视频任务状态/成品 URL

密钥来源（不落明文，两级解析）：
  ① 环境变量 HERMES_CUSTOM_API_AGNES_AI_CN_API_KEY
  ② 加密 providers.enc.json 中 api_base 含 "agnes-ai" 的 provider 的 api_key
权限 network（L4）；slime.toml [sandbox].auto_approve_tools 已放行 "agnes_*"。
"""

import asyncio
import base64
import hashlib
import json
import logging
import os
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

_API_BASE = "https://api.agnes-ai.cn/v1"
# A-048-R3（真实调用根因）：视频状态查询**必须用 video_id（video_ 开头）走推荐端点**
# /agnesapi?video_id=<VIDEO_ID>——该端点完成态响应含 url 字段；
# 旧式 task_id 查询（/v1/videos/{task_id}）完成态无 url，且官方文档明确
# "用 video_id 查询，不要用 task_id，否则会异常排队"。_video_status_url() 负责分流。
_POLL_BASE = "https://api.agnes-ai.cn/agnesapi"
_ENV_KEY = "HERMES_CUSTOM_API_AGNES_AI_CN_API_KEY"
_IMAGE_MODEL = "agnes-image-2.1-flash"
_VIDEO_MODEL = "agnes-video-v2.0"


def _media_config() -> dict:
    """A-053: 从 slime.toml [media] 段读取媒体配置（端点/模型名/密钥环境变量名），
    缺省回退内置默认——出厂重置/更换平台时改配置即可，无代码硬编码。"""
    try:
        toml_path = _PROJECT_ROOT / "slime.toml"
        if toml_path.exists():
            import tomllib
            with open(toml_path, "rb") as f:
                return dict(tomllib.load(f).get("media", {}))
    except Exception:
        pass
    return {}


def _cfg_or(key: str, default: str) -> str:
    val = _media_config().get(key)
    return str(val).strip() if val else default
_IMAGE_SIZES = ("1K", "2K", "3K", "4K")
_IMAGE_RATIOS = ("1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9")
_MAX_IMAGE_BYTES = 8 * 1024 * 1024
_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
_VIDEO_POLL_ATTEMPTS = 20   # A-046: 20×15s=300s 内轮询（视频生成通常 1-5 分钟）
_VIDEO_POLL_INTERVAL = 15.0
_VIDEO_MIN_INTERVAL = 65.0  # A-074: 单 key 最小提交间隔（60s 滚动窗口 + 5s 时钟漂移缓冲）

# A-072: 视频 API 免费限速 1 RPM（每分钟 1 条，滑动窗口 60s）——客户端主动节流
# 按 api_key 记录上次视频提交时间，提交前等满 60s 窗口（不再依赖 429 重试）
_last_video_submit: dict[str, float] = {}
_video_submit_lock: asyncio.Lock | None = None


def _get_video_submit_lock() -> asyncio.Lock:
    """进程级视频提交互斥锁（并发 Worker 共享同一限速池时排队）"""
    global _video_submit_lock
    if _video_submit_lock is None:
        _video_submit_lock = asyncio.Lock()
    return _video_submit_lock


async def _wait_video_slot(key: str) -> None:
    """A-072/A-074: 提交视频前等待限速窗口（同一 key 距上次提交 ≥65s）。

    A-074 修订（风控指纹与时钟漂移）：
    ① 间隔 60→65s——服务器 60s 为滚动窗口，本地时钟与服务器窗口可能漂移，
       预留 5s 缓冲消除边界偶发 429；
    ② 额外随机抖动 random.uniform(2, 15)s——破坏"完美均匀间隔"的自动化流水线指纹
       （真人时序不可能如此规整，风控时序特征库易命中）。
    两者都只增加同一 key 的提交间隔（更保守），不同 key 独立窗口不受影响
    （多账号轮转并行不受阻塞）——不违背并发提速。
    """
    import random as _random
    lock = _get_video_submit_lock()
    async with lock:
        last = _last_video_submit.get(key, 0.0)
        wait = _VIDEO_MIN_INTERVAL - (time.time() - last)
        if wait > 0:
            jitter = _random.uniform(2.0, 15.0)
            logging.info(f"[agnes] 视频限速等待 {wait:.0f}s+抖动{jitter:.0f}s（1 RPM 窗口，key {key[:8]}…）")
            await asyncio.sleep(wait + jitter)
        _last_video_submit[key] = time.time()
_RETRY_429_BACKOFF = (5.0, 15.0, 30.0, 60.0)  # A-057/A-059: 覆盖视频 API 约 1 分钟限流窗口
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_GENERATED_DIR = _PROJECT_ROOT / "data" / "generated"

# A-048: 反幻觉声明（写入每个工具 description，模型每次调用前可见）
_ANTI_HALLUCINATION_NOTE = (
    "调用本工具是生成图片/视频的唯一途径：未调用本工具时禁止声称已生成任何图片/视频。"
    "工具返回以 [错误] 开头表示失败，必须如实转述，不得包装为成功。"
)

# A-048: FACE_STANDARD 浓缩画质段（真人/脸部质量要求时追加，替代 reality-prompts）
_FACE_QUALITY_CN = (
    "真实自然的五官，皮肤质感细腻真实，眼神清澈有神，发丝细节丰富，"
    "表情自然不僵硬，杜绝塑料感或洋娃娃感"
)
_FACE_QUALITY_EN = (
    "ultra-realistic facial details, natural skin texture and pores, "
    "clear eyes with natural reflections, realistic hair strands, "
    "natural expressions, no plastic or doll-like appearance"
)
# A-048（review 修复）：人脸启发式关键词——face_quality 未显式传值时，
# 主体/场景/细节含人物词才追加脸部画质段（风景/产品不污染）
_FACE_HINTS = ("人", "女", "男", "少女", "少年", "学生", "模特", "情侣",
               "face", "portrait", "woman", "man", "girl", "boy",
               "person", "selfie", "headshot", "avatar")
# 通用画质增强段（图片/视频共用，追加在 prompt 末尾）
_QUALITY_SUFFIX = "，高清画质，自然光影，画面清晰锐利，色彩自然"


async def _download_async(url: str, subdir: str) -> str:
    """A-040: 下载远程文件到 data/generated/<subdir>/，返回本地绝对路径。
    失败返回空串（调用方据此明确返回"未保存到本地"，不给模型编造空间）。
    A-048（review 修复）：同 URL 已下载过（如 status 重复轮询）直接复用缓存，
    避免磁盘膨胀与重复下载。"""
    if not url:
        return ""
    try:
        suffix = Path(urlsplit(url).path).suffix.lower() or ".bin"
        out_dir = _GENERATED_DIR / subdir
        out_dir.mkdir(parents=True, exist_ok=True)
        md5 = hashlib.md5(url.encode("utf-8")).hexdigest()[:8]
        # 缓存命中：文件名含 url md5（{时间戳}_{md5}{后缀}），前缀可变只匹配 md5 段
        cached = list(out_dir.glob(f"*_{md5}{suffix}"))
        if cached:
            return str(cached[0])
        name = f"{int(time.time())}_{md5}{suffix}"
        out_path = out_dir / name
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            async with client.stream("GET", url) as resp:
                resp.raise_for_status()
                total = 0
                with open(out_path, "wb") as f:
                    async for chunk in resp.aiter_bytes():
                        total += len(chunk)
                        if total > _MAX_DOWNLOAD_BYTES:
                            f.close()
                            out_path.unlink(missing_ok=True)
                            logging.warning("[agnes_media] 下载超过 50MB 上限，已中止")
                            return ""
                        f.write(chunk)
        return str(out_path)
    except Exception as e:
        logging.warning(f"[agnes_media] 下载失败: {e}")
        return ""


def _get_api_key() -> str:
    """密钥解析（A-048-R4：按调用方 Agent 分配账号）：
    ① 环境变量 HERMES_CUSTOM_API_AGNES_AI_CN_API_KEY（显式设置优先）
    ② 当前调用 Agent 的 model_choice（api:<provider_key>）对应 provider（各 Agent 不同 Agnes 账号）
    ③ 回退：任意 api_base 含 agnes-ai 的 provider（无 Agent 上下文时，保持旧行为）"""
    key = os.environ.get(_cfg_or("env_key", _ENV_KEY), "").strip()
    if key:
        return key
    try:
        from core.encryption import decrypt
        providers = decrypt() or {}

        # ② 按当前调用 Agent 的 provider 解析（contextvar 由 core/llm.py 工具循环设置）
        try:
            from core.agent_context import current_model_choice
            mc = current_model_choice.get()
        except Exception:
            mc = ""
        if mc and str(mc).startswith("api:"):
            cfg = providers.get(str(mc)[4:])
            if isinstance(cfg, dict) and "agnes-ai" in str(cfg.get("api_base", "")):
                k = str(cfg.get("api_key", "")).strip()
                if k:
                    return k

        # ③ 回退：任意 agnes-ai provider（无 Agent 上下文/直调场景）
        for cfg in providers.values():
            if not isinstance(cfg, dict):
                continue
            base = str(cfg.get("api_base", ""))
            k = str(cfg.get("api_key", "")).strip()
            if "agnes-ai" in base and k:
                return k
    except Exception as e:
        logging.warning(f"[agnes_media] 读取加密 Provider 失败: {e}")
    return ""


def _no_key_error() -> str:
    return (
        "未找到 Agnes API 密钥：请设置环境变量 "
        f"{_ENV_KEY}，或在 /provider 中添加 api_base 含 agnes-ai 的 Provider"
    )


async def _post_json(url: str, payload: dict, timeout: float = 60.0) -> dict:
    """POST JSON → dict；任何失败都归一化为 {"__error": 文案}（不抛异常）。
    A-057: 429 限流退避重试（Swarm 多段并行时缓解）。"""
    key = _get_api_key()
    if not key:
        return {"__error": _no_key_error()}
    import asyncio as _a
    for attempt, delay in enumerate(_RETRY_429_BACKOFF):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    url,
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    json=payload,
                )
                if resp.status_code == 429 and attempt < len(_RETRY_429_BACKOFF) - 1:
                    await _a.sleep(delay)
                    continue
                resp.raise_for_status()
                data = resp.json()
            return data if isinstance(data, dict) else {
                "__error": f"响应格式异常: {str(data)[:200]}"
            }
        except httpx.HTTPStatusError as e:
            if e.response is not None and e.response.status_code == 429 \
                    and attempt < len(_RETRY_429_BACKOFF) - 1:
                await _a.sleep(delay)
                continue
            detail = ""
            try:
                detail = str(e.response.json())[:200]
            except Exception:
                detail = ""
            return {"__error": f"Agnes API {e.response.status_code}: {detail or type(e).__name__}"}
        except httpx.HTTPError as e:
            return {"__error": f"请求失败: {str(e) or type(e).__name__}"}
    return {"__error": "Agnes API 429: 重试后仍限流"}


async def _get_json(url: str, timeout: float = 30.0) -> dict:
    key = _get_api_key()
    if not key:
        return {"__error": _no_key_error()}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(
                url,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            )
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, dict) else {
                "__error": f"响应格式异常: {str(data)[:200]}"
            }
    except httpx.HTTPStatusError as e:
        return {"__error": f"Agnes API {e.response.status_code}: {type(e).__name__}"}
    except httpx.HTTPError as e:
        return {"__error": f"请求失败: {str(e) or type(e).__name__}"}


def _encode_image(path: str) -> str:
    """本地图片 → base64 data URL。失败抛 ValueError（工具层转友好文案）。"""
    p = Path(path)
    if not p.is_file():
        raise ValueError(f"图片文件不存在: {path}")
    if p.stat().st_size > _MAX_IMAGE_BYTES:
        raise ValueError("图片超过 8MB，请压缩后再试")
    data = base64.b64encode(p.read_bytes()).decode()
    ext = p.suffix.lower().lstrip(".")
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
            "webp": "image/webp"}.get(ext, "image/jpeg")
    return f"data:{mime};base64,{data}"


def _encode_image_arg(image: str):
    """A-048-R5：image 参数归一化——http(s) URL 直接透传（官方文档图生图/图生视频
    支持公开图片 URL；模型常把生图工具返回的 URL 直接用于图生视频），
    本地路径 → base64 data URL。此前只支持本地路径，模型传 URL 时工具报
    "图片文件不存在" → 弱模型忽略错误编造"已完成"（用户实测：图生视频声称完成但目录为空）。"""
    img = str(image).strip()
    if img.lower().startswith(("http://", "https://")):
        return img
    return _encode_image(img)


def _real_size(path: str) -> int:
    """真实文件字节数（证据）；文件不存在返回 0。"""
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _report_progress(progress, tool_name: str = "视频生成") -> None:
    """A-050: 把生成进度上报到当前工具执行的进度队列（core.llm 流式循环读取并
    转发为 progress 事件 → CLI 进度条）。无执行上下文（直调）时静默忽略。"""
    try:
        from core.agent_context import tool_progress_q
        q = tool_progress_q.get()
        if q is not None:
            q.put_nowait({"progress": int(progress or 0), "tool": tool_name})
    except Exception:
        pass


def _video_status_url(video_id: str) -> str:
    """A-048-R3：状态查询 URL 分流——video_ 开头走推荐端点（完成态含 url），
    task_ 开头走兼容端点（可查状态但完成态无 url，如实提示用 video_id 查成品）。"""
    if str(video_id).startswith("video_"):
        from urllib.parse import urlencode
        return f"{_cfg_or('poll_base', _POLL_BASE)}?{urlencode({'video_id': video_id})}"
    return f"{_cfg_or('api_base', _API_BASE)}/videos/{video_id}"


def _extract_video_url(status: dict) -> str:
    """A-048-R3：从完成态响应提取成品 URL——按官方文档字段兼容提取：
    url（推荐端点实测字段）→ video_url → metadata.url → remixed_from_video_id。"""
    if not isinstance(status, dict):
        return ""
    for key in ("url", "video_url"):
        val = status.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    meta = status.get("metadata")
    if isinstance(meta, dict):
        val = meta.get("url")
        if isinstance(val, str) and val.strip():
            return val.strip()
    val = status.get("remixed_from_video_id")
    if isinstance(val, str) and val.strip() and val.startswith("http"):
        return val.strip()
    return ""


# ── 配套提示词工具（A-048：规则式，不调 LLM，确定性输出）────────────────

async def _tool_prompt_build(args: dict) -> str:
    """把用户需求构建为可直接使用的生成 prompt + 参数建议。

    规则式拼接（非 LLM），输入支持中/英文原文；有真人/脸部质量要求时
    自动追加 FACE_STANDARD 浓缩画质段（替代原 reality-prompts skill）。"""
    media_type = str(args.get("media_type", "image")).strip().lower()
    if media_type not in ("image", "video"):
        return "[错误] media_type 必须为 image 或 video"
    subject = str(args.get("subject", "")).strip()
    if not subject:
        return "[错误] 缺少 subject 参数（主体描述，如：清纯女大学生在校园散步）"
    scene = str(args.get("scene", "")).strip()
    style = str(args.get("style", "")).strip()
    detail = str(args.get("detail", "")).strip()
    # A-048（review 修复）：face_quality 未显式传值时按主体/场景/细节关键词启发式
    # 判断（人物主体追加脸部画质段，风景/产品不污染）
    face_arg = args.get("face_quality")
    if face_arg is None:
        hint_text = (subject + scene + detail).lower()
        face_quality = any(h in hint_text for h in _FACE_HINTS)
    else:
        face_quality = bool(face_arg)

    parts = [subject]
    if scene:
        parts.append(f"，场景：{scene}")
    if style:
        parts.append(f"，风格：{style}")
    if detail:
        parts.append(f"，细节：{detail}")
    if face_quality:
        parts.append(f"，{_FACE_QUALITY_CN}")
    parts.append(_QUALITY_SUFFIX)
    prompt = "".join(parts)

    # 参数建议（确定性规则）
    if media_type == "image":
        ratio = str(args.get("ratio", "1:1"))
        if ratio not in _IMAGE_RATIOS:
            ratio = "1:1"
        size = str(args.get("size", "2K")).upper()
        if size not in _IMAGE_SIZES:
            size = "2K"
        return (
            f"[提示词构建完成（image）]\n"
            f"prompt: {prompt}\n"
            f"建议参数: size={size}, ratio={ratio}\n"
            f"调用 agnes_generate_image(prompt=上述 prompt, size={size}, ratio={ratio}) 生成。"
        )
    duration = str(args.get("duration", "5"))
    try:
        duration = str(max(1, min(18, int(duration))))
    except (TypeError, ValueError):
        duration = "5"
    video_size = str(args.get("video_size", "1280x720")).strip() or "1280x720"
    return (
        f"[提示词构建完成（video）]\n"
        f"prompt: {prompt}\n"
        f"建议参数: duration={duration} 秒, video_size={video_size}\n"
        f"调用 agnes_generate_video(prompt=上述 prompt, duration={duration}, "
        f"video_size={video_size}) 生成（异步，1-5 分钟）。"
    )


async def _extract_last_frame(video_path: str, out_png: str) -> str:
    """A-063: 用 ffmpeg 抽取视频末帧（链式参考帧用）。成功返回帧路径，失败返回空串。"""
    import subprocess
    ffmpeg = _cfg_or("ffmpeg", "")
    if not ffmpeg or not Path(ffmpeg).is_file():
        import shutil
        ffmpeg = shutil.which("ffmpeg") or ""
    if not ffmpeg or not Path(ffmpeg).is_file():
        return ""
    try:
        out = Path(out_png)
        out.parent.mkdir(parents=True, exist_ok=True)
        # -sseof -0.1: 从文件末尾前 0.1 秒取一帧（末帧）
        r = subprocess.run(
            [ffmpeg, "-y", "-sseof", "-0.1", "-i", str(video_path),
             "-frames:v", "1", str(out)],
            capture_output=True, text=True, timeout=60,
        )
        return str(out) if r.returncode == 0 and out.is_file() else ""
    except Exception:
        return ""


# ── 工具执行体 ─────────────────────────────────────────────


def _media_cache_path(kind: str, key_hash: str) -> Path:
    """A-073: 内容寻址缓存路径——data/generated/{images|videos}/cache_{hash}.{ext}"""
    sub = "images" if kind == "image" else "videos"
    ext = ".png" if kind == "image" else ".mp4"
    d = _GENERATED_DIR / sub
    d.mkdir(parents=True, exist_ok=True)
    return d / f"cache_{key_hash}{ext}"


def _media_cache_key(kind: str, prompt: str, size: str, model: str,
                     image_arg: str = "") -> str:
    """A-073: 缓存键 = sha256(prompt+size+model+image_arg) 前 16 位。
    相同请求（重试/微调同描述）命中缓存 → 不调用 API（合规降需，官方推荐手段）。"""
    raw = f"{kind}|{prompt}|{size}|{model}|{image_arg}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _format_cache_hit(path: Path) -> str:
    """缓存命中返回格式（明确标注未调用 API）"""
    return (f"生成结果命中本地缓存（与上次请求相同，未调用 API，未消耗配额）。\n"
            f"本地文件: {path}（{_real_size(str(path))} 字节）\n"
            f"如需强制重新生成请加参数 refresh=true")


async def _tool_generate_image(args: dict) -> str:
    prompt = str(args.get("prompt", "")).strip()
    if not prompt:
        return "[错误] 缺少 prompt 参数"
    size = str(args.get("size", "2K")).upper()
    if size not in _IMAGE_SIZES:
        return f"[错误] size 必须为 {'/'.join(_IMAGE_SIZES)}（默认 2K）"
    ratio = str(args.get("ratio", "1:1"))
    if ratio not in _IMAGE_RATIOS:
        return f"[错误] ratio 必须为 {'/'.join(_IMAGE_RATIOS)}（默认 1:1）"
    payload = {"model": _cfg_or("image_model", _IMAGE_MODEL), "prompt": prompt,
               "size": size, "ratio": ratio}
    image_path = str(args.get("image", "")).strip()
    # A-073: 缓存命中直接返回（不调用 API）；refresh=true 强制重新生成
    if not str(args.get("refresh", "")).strip().lower() in ("true", "1", "yes"):
        _cache_key = _media_cache_key("image", prompt, size,
                                      _cfg_or("image_model", _IMAGE_MODEL), image_path)
        _cached = _media_cache_path("image", _cache_key)
        if _cached.exists():
            return _format_cache_hit(_cached)
    if image_path:
        try:
            payload["image"] = [_encode_image_arg(image_path)]
        except ValueError as e:
            return f"[错误] {e}"
    result = await _post_json(f"{_cfg_or('api_base', _API_BASE)}/images/generations", payload)
    if "__error" in result:
        return f"[错误] {result['__error']}"
    data = result.get("data") or []
    if not data or not data[0].get("url"):
        return f"[错误] 响应缺少图片 URL: {json.dumps(result, ensure_ascii=False)[:300]}"
    url = data[0]["url"]
    local = await _download_async(url, "images")
    if local:
        # A-073: 写入内容寻址缓存（下次同请求直接命中，不调 API）
        try:
            import shutil
            _cache_key = _media_cache_key("image", prompt, size,
                                          _cfg_or("image_model", _IMAGE_MODEL), image_path)
            shutil.copyfile(local, _media_cache_path("image", _cache_key))
        except Exception:
            pass
        size = _real_size(local)
        return (f"图片生成成功（真实证据：本地文件已保存）。\n"
                f"本地文件: {local}（{size} 字节）\nURL: {url}")
    # A-048: 下载失败必须明确"未保存到本地"，绝不出现"成功"字样（防模型脑补本地路径）
    return (f"[错误] 图片已生成，但未保存到本地（下载失败）。\n"
            f"URL: {url}\n请将 URL 告知用户，或稍后重试生成。")


async def _tool_generate_video(args: dict) -> str:
    prompt = str(args.get("prompt", "")).strip()
    if not prompt:
        return "[错误] 缺少 prompt 参数"
    try:
        duration = int(args.get("duration", 5))
    except (TypeError, ValueError):
        duration = 5
    duration = max(1, min(18, duration))
    size = str(args.get("video_size", args.get("size", "1280x720"))).strip() or "1280x720"
    payload = {"model": _cfg_or("video_model", _VIDEO_MODEL), "prompt": prompt,
               "duration": duration, "size": size}
    image_path = str(args.get("image", "")).strip()
    # A-073: 视频缓存命中直接返回（不调用 API、不消耗视频配额）；refresh=true 强制重生成
    if not str(args.get("refresh", "")).strip().lower() in ("true", "1", "yes"):
        _cache_key = _media_cache_key("video", prompt, size,
                                      _cfg_or("video_model", _VIDEO_MODEL), image_path)
        _cached = _media_cache_path("video", _cache_key)
        if _cached.exists():
            return _format_cache_hit(_cached)
    if image_path:
        # A-083: 图生视频时自动追加人物/画面一致性指令——参考图来自前段末帧，
        # 模型 prompt 可能自行引入新人物（"一会男人一会女人"），工具层强制声明保持。
        _keep_note = (
            "\nIMPORTANT: Keep the SAME characters (identical faces, hairstyles, clothing, "
            "body and seating positions) as the reference image. Do NOT introduce or swap "
            "any person. The scene, props and camera must continue from the reference frame."
        )
        if _keep_note not in prompt:
            prompt = prompt + _keep_note
        payload["prompt"] = prompt
        try:
            payload["image"] = _encode_image_arg(image_path)
        except ValueError as e:
            return f"[错误] {e}"
    # A-072: 客户端主动节流——提交前等满 60s 限速窗口（1 RPM），彻底避免 429
    await _wait_video_slot(_get_api_key())
    result = await _post_json(f"{_cfg_or('api_base', _API_BASE)}/videos", payload)
    if "__error" in result:
        return f"[错误] {result['__error']}"
    # A-048-R3（真实调用根因）：创建响应同时返回 id(task_xxx) 与 video_id(video_xxx)，
    # **必须优先用 video_id**——官方文档明确"用 video_id 查询，不要用 task_id"
    # （task_id 查询会异常排队，且完成态响应不含 url 字段；video_id 查询的
    # /agnesapi?video_id= 完成态含 url）。此前优先取 id 导致永远拿不到成品 URL。
    video_id = result.get("video_id") or result.get("id") or result.get("task_id")
    if not video_id:
        return f"[错误] 响应缺少视频任务 ID: {json.dumps(result, ensure_ascii=False)[:300]}"

    # 有限轮询（最长约 5 分钟），未完成则给用户明确指引
    progress = 0
    for _ in range(_VIDEO_POLL_ATTEMPTS):
        await asyncio.sleep(_VIDEO_POLL_INTERVAL)
        status = await _get_json(_video_status_url(video_id))
        if "__error" in status:
            return (f"[错误] 视频任务已提交（ID: {video_id}），但状态查询失败: "
                    f"{status['__error']}。任务未确认完成，稍后可用 agnes_video_status 查询。")
        state = str(status.get("status", "unknown"))
        progress = status.get("progress", 0)
        _report_progress(progress)  # A-050: 上报进度供 CLI 进度条
        if state == "completed":
            url = _extract_video_url(status)
            if url:
                local = await _download_async(url, "videos")
                if local:
                    # A-073: 写入内容寻址缓存（下次同请求直接命中）
                    try:
                        import shutil
                        _cache_key = _media_cache_key("video", prompt, size,
                                                      _cfg_or("video_model", _VIDEO_MODEL), image_path)
                        shutil.copyfile(local, _media_cache_path("video", _cache_key))
                    except Exception:
                        pass
                    bytes_size = _real_size(local)
                    return (f"视频生成完成（真实证据：本地文件已保存）。\n"
                            f"本地文件: {local}（{bytes_size} 字节）\nURL: {url}")
                # A-048: 明确"未保存到本地"，且不用"完成"字样（图片路径用"已生成"，
                # 视频路径同样规避——"生成完成"会给弱模型编造空间的入口）
                return (f"[错误] 视频已生成，但未保存到本地（下载失败）。\n"
                        f"URL: {url}\n请将 URL 告知用户。")
            return f"[错误] 视频任务已完成（{video_id}），但平台响应未包含成品 URL，无法下载到本地。请将任务 ID 告知用户，可再次调用 agnes_video_status(video_id=\"{video_id}\") 查询。"
        if state == "failed":
            return f"[错误] 视频生成失败: {status.get('error') or '未知原因'}"
    # A-048: 未完成 → 明确"未完成"，禁止任何完成态表述
    return (f"[进行中] 视频任务已提交（ID: {video_id}），已轮询约 5 分钟仍未完成"
            f"（当前进度 {progress}%）。视频生成通常需要 1-5 分钟。\n"
            f"请如实告知用户\u201c视频仍在生成中，未完成\u201d，稍后调用 "
            f"agnes_video_status(video_id=\"{video_id}\") 查询成品。")


async def _tool_video_status(args: dict) -> str:
    video_id = str(args.get("video_id", "")).strip()
    if not video_id:
        return "[错误] 缺少 video_id 参数"
    status = await _get_json(_video_status_url(video_id))
    if "__error" in status:
        return f"[错误] {status['__error']}"
    state = str(status.get("status", "unknown"))
    progress = status.get("progress", 0)
    _report_progress(progress, tool_name="视频状态查询")  # A-050
    if state == "completed":
        url = _extract_video_url(status)
        if url:
            local = await _download_async(url, "videos")
            if local:
                bytes_size = _real_size(local)
                return (f"视频已完成（真实证据：本地文件已保存）。\n"
                        f"本地文件: {local}（{bytes_size} 字节）\nURL: {url}")
            # A-048: 不用"已完成"字样（见 generate_video 同规则）
            return f"[错误] 视频已生成，但未保存到本地（下载失败）。\nURL: {url}"
        return f"[错误] 视频已完成（进度 100%）但平台响应未包含成品 URL，无法下载到本地。请将任务 ID 告知用户，可再次调用本工具查询。"
    if state == "failed":
        return f"[错误] 生成失败: {status.get('error') or '未知原因'}"
    return f"[进行中] 状态: {state}，进度: {progress}%。视频未完成，可稍后再次查询。"


async def _tool_video_concat(args: dict) -> str:
    """A-059: 用 ffmpeg 把多段视频按顺序拼接为一个完整视频。
    videos: 本地 mp4 路径列表（按播放顺序）；输出到 data/generated/videos/concat_*.mp4。
    先 -c copy 快拼接（同编码），失败自动回退重编码拼接。"""
    videos = args.get("videos") or args.get("video_paths") or []
    if not isinstance(videos, list) or len(videos) < 2:
        return "[错误] videos 参数需为至少 2 个本地 mp4 路径的列表"
    paths = []
    for v in videos:
        p = Path(str(v).strip())
        if not p.is_absolute():
            p = _PROJECT_ROOT / p
        if not p.is_file() or p.suffix.lower() != ".mp4":
            return f"[错误] 视频文件不存在或非 mp4: {v}"
        paths.append(str(p.resolve()))

    # ffmpeg 路径：slime.toml [media].ffmpeg → 环境 PATH → 常见目录
    ffmpeg = _cfg_or("ffmpeg", "")
    if not ffmpeg or not Path(ffmpeg).is_file():
        import shutil
        ffmpeg = shutil.which("ffmpeg") or ""
    if not ffmpeg or not Path(ffmpeg).is_file():
        return "[错误] 未找到 ffmpeg（可在 slime.toml [media].ffmpeg 配置路径）"

    out_dir = _GENERATED_DIR / "videos"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"concat_{int(time.time())}.mp4"

    # 方式 1：concat demuxer + copy（同编码快拼）
    list_file = out_dir / f".concat_{int(time.time())}.txt"
    try:
        list_file.write_text(
            "\n".join(f"file '{p.replace(chr(39), chr(39) + chr(92) + chr(39))}'" for p in paths),
            encoding="utf-8")
        import subprocess
        r = subprocess.run(
            [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
             "-c", "copy", str(out_path)],
            capture_output=True, text=True, timeout=300,
        )
        if r.returncode != 0 or not out_path.exists():
            # 方式 2：重编码拼接（不同编码/参数兜底）
            inputs = []
            for p in paths:
                inputs += ["-i", p]
            r2 = subprocess.run(
                [ffmpeg, "-y"] + inputs +
                ["-filter_complex", f"concat=n={len(paths)}:v=1:a=0",
                 "-c:v", "libx264", "-preset", "fast", str(out_path)],
                capture_output=True, text=True, timeout=600,
            )
            if r2.returncode != 0 or not out_path.exists():
                return f"[错误] 视频拼接失败: {(r.stderr or r2.stderr or '')[-200:]}"
    except Exception as e:
        return f"[错误] 视频拼接失败: {str(e)[:200]}"
    finally:
        try:
            list_file.unlink(missing_ok=True)
        except Exception:
            pass

    size = _real_size(str(out_path))
    return (f"视频拼接完成（真实证据：本地文件已保存）。\n"
            f"本地文件: {out_path}（{size} 字节）\n"
            f"共拼接 {len(paths)} 段 → 1 个完整视频")


# ── 注册 ───────────────────────────────────────────────────


def register_agnes_media_tools() -> int:
    """注册 4 个 Agnes 媒体工具到统一注册表（同名非 force 拒绝覆盖）。返回注册数。"""
    from tools.registry import Tool, get_registry
    reg = get_registry()
    count = 0
    count += 1 if reg.register(Tool(
        name="agnes_prompt_build",
        description=(
            "构建图片/视频生成的生成提示词（规则式，确定性输出，不调用 LLM）。"
            "生图/生视频前先调用本工具：传入 media_type（image/video）+ subject（主体，"
            "中英文均可）+ 可选 scene/style/detail/face_quality，返回可直接作为 "
            "agnes_generate_image / agnes_generate_video 的 prompt 参数，并附参数建议。"
            "有真人/脸部质量要求时自动追加 FACE_STANDARD 画质段。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "media_type": {"type": "string", "enum": ["image", "video"],
                               "description": "生成类型：image=图片 / video=视频", "default": "image"},
                "subject": {"type": "string", "description": "主体描述（中英文均可），如：清纯女大学生在校园散步"},
                "scene": {"type": "string", "description": "场景描述，如：大学校园林荫道、自然光"},
                "style": {"type": "string", "description": "风格描述，如：清新自然、日系摄影"},
                "detail": {"type": "string", "description": "额外细节要求"},
                "face_quality": {"type": "boolean",
                                 "description": "是否启用真人脸部质量标准；不传时按主体自动判断（人物主体自动开启，风景/产品不追加）", "default": None},
                "ratio": {"type": "string", "enum": list(_IMAGE_RATIOS), "description": "图片比例（image 时用）"},
                "size": {"type": "string", "enum": list(_IMAGE_SIZES), "description": "图片分辨率（image 时用）"},
                "duration": {"type": "integer", "description": "视频时长秒数 1-18（video 时用）"},
                "video_size": {"type": "string", "description": "视频分辨率（video 时用）"},
            },
            "required": ["media_type", "subject"],
        },
        execute_fn=_tool_prompt_build,
        permissions=["read"],
    )) else 0
    count += 1 if reg.register(Tool(
        name="agnes_generate_image",
        description=(
            "调用同厂 Agnes 图像模型（agnes-image-2.1-flash）生成**图片/照片/海报/头像**。"
            "支持文生图与图生图（image 传本地图片路径，自动 base64）。"
            "**选择依据（A-085）**：用户要「图片/照片/图/海报/头像/壁纸」→ 必须用本工具；"
            "用户要「视频/短片/动画」→ 用 agnes_generate_video，**禁止把图片请求改成视频生成**。"
            "成功时返回本地文件路径（含真实字节数）与 URL；下载失败会明确返回"
            "\u201c未保存到本地\u201d，此时只有 URL 可用。"
            "提示词建议先经 agnes_prompt_build 构建。"
            f"{_ANTI_HALLUCINATION_NOTE}"
        ),
        parameters={
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "图片描述（建议先用 agnes_prompt_build 构建）"},
                "size": {"type": "string", "enum": list(_IMAGE_SIZES),
                         "description": "分辨率：1K草稿/2K标准/3K高质量/4K最高", "default": "2K"},
                "ratio": {"type": "string", "enum": list(_IMAGE_RATIOS),
                          "description": "比例，如 16:9", "default": "1:1"},
                "image": {"type": "string",
                          "description": "图生图时的源图片：本地路径或 http(s) 图片 URL（可选）"},
            },
            "required": ["prompt"],
        },
        execute_fn=_tool_generate_image,
        permissions=["network"],
    )) else 0
    count += 1 if reg.register(Tool(
        name="agnes_generate_video",
        description=(
            "调用同厂 Agnes 视频模型（agnes-video-v2.0）生成**视频/短片/动画**（异步任务，1-5 分钟）。"
            "支持文生视频与图生视频；提交后轮询约 5 分钟。"
            "**选择依据（A-085）**：用户要「视频/短片/动画/剪辑」→ 必须用本工具；"
            "用户要「图片/照片/图/海报」→ 用 agnes_generate_image，**禁止把图片请求改成视频生成**。"
            "完成时返回本地文件路径（含真实字节数）与 URL；未完成时返回任务 ID 与进度"
            "（必须如实告知用户\u201c未完成\u201d），稍后用 agnes_video_status 查询。"
            f"{_ANTI_HALLUCINATION_NOTE}"
        ),
        parameters={
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "视频描述（建议先用 agnes_prompt_build 构建）"},
                "duration": {"type": "integer", "description": "时长秒数 1-18", "default": 5},
                "video_size": {"type": "string",
                               "description": "分辨率，如 1280x720 / 720x1280", "default": "1280x720"},
                "image": {"type": "string",
                          "description": "图生视频时的源图片：本地路径或 http(s) 图片 URL（可选）"},
            },
            "required": ["prompt"],
        },
        execute_fn=_tool_generate_video,
        permissions=["network"],
    )) else 0
    count += 1 if reg.register(Tool(
        name="video_concat",
        description=(
            "用 ffmpeg 把多段本地 mp4 视频按顺序拼接为一个完整视频（Swarm 分段视频整合用）。"
            "videos 传本地 mp4 路径列表（按播放顺序）；先 -c copy 快拼，失败自动重编码。"
            "拼接成功返回本地完整视频路径与真实字节数。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "videos": {"type": "array", "items": {"type": "string"},
                           "description": "本地 mp4 路径列表（按播放顺序，至少 2 个）"},
            },
            "required": ["videos"],
        },
        execute_fn=_tool_video_concat,
        permissions=["read"],
    )) else 0
    count += 1 if reg.register(Tool(
        name="agnes_video_status",
        description=(
            "查询 Agnes 视频生成任务的实时状态。未完成返回\u201c进行中\u201d；"
            "完成后自动下载到本地 data/generated/videos/ 并返回本地路径（含真实字节数）"
            "与 URL；下载失败明确返回\u201c未保存到本地\u201d（只有 URL 可用）。"
            "video_id 由 agnes_generate_video 返回。"
        ),
        parameters={
            "type": "object",
            "properties": {
                "video_id": {"type": "string", "description": "视频任务 ID"},
            },
            "required": ["video_id"],
        },
        execute_fn=_tool_video_status,
        permissions=["network"],
    )) else 0
    return count
