"""Agnes 媒体工具测试（A-035 基础 + A-048 反幻觉强化）"""

import asyncio
import json
from unittest.mock import patch


class TestAgnesMediaTools:
    def test_no_key_error(self):
        from tools.agnes_media import _tool_generate_image
        with patch("tools.agnes_media._get_api_key", return_value=""):
            r = asyncio.run(_tool_generate_image({"prompt": "a cat"}))
        assert "未找到 Agnes API 密钥" in r

    def test_generate_image_success_and_normalization(self):
        from tools.agnes_media import _tool_generate_image
        captured = {}

        async def fake_post(url, payload, timeout=60.0):
            captured.update(payload)
            return {"data": [{"url": "https://example.com/img.png"}]}

        with patch("tools.agnes_media._post_json", new=fake_post), \
             patch("tools.agnes_media._download_async", return_value="D:\\x\\img.png"), \
             patch("tools.agnes_media._wait_video_slot", new=lambda k: __import__("asyncio").sleep(0)), \
             patch("tools.agnes_media._real_size", return_value=123456):
            r = asyncio.run(_tool_generate_image(
                {"prompt": "a cat", "size": "2k", "ratio": "16:9"}))
        assert "图片生成成功" in r
        assert "https://example.com/img.png" in r
        assert "D:\\x\\img.png" in r
        assert "123456 字节" in r          # A-048: 成功返回真实文件大小（证据）
        assert captured["model"] == "agnes-image-2.1-flash"
        assert captured["size"] == "2K"  # 小写归一化
        assert captured["ratio"] == "16:9"

    def test_generate_image_invalid_params(self):
        from tools.agnes_media import _tool_generate_image
        assert "缺少 prompt" in asyncio.run(_tool_generate_image({}))
        assert "size 必须为" in asyncio.run(_tool_generate_image({"prompt": "x", "size": "9K"}))
        assert "ratio 必须为" in asyncio.run(_tool_generate_image({"prompt": "x", "ratio": "5:5"}))

    def test_generate_image_missing_url(self):
        from tools.agnes_media import _tool_generate_image

        async def fake_post(url, payload, timeout=60.0):
            return {"data": []}

        with patch("tools.agnes_media._post_json", new=fake_post):
            r = asyncio.run(_tool_generate_image({"prompt": "x"}))
        assert "缺少图片 URL" in r

    def test_generate_image_download_failure_is_clear_error(self):
        """A-048 核心回归：下载失败必须明确"未保存到本地"（此前返回"生成成功"，
        弱模型据此脑补本地路径与文件大小——用户实测目录为空仍声称已保存）"""
        from tools.agnes_media import _tool_generate_image

        async def fake_post(url, payload, timeout=60.0):
            return {"data": [{"url": "https://example.com/img.png"}]}

        with patch("tools.agnes_media._post_json", new=fake_post), \
             patch("tools.agnes_media._download_async", return_value=""):
            r = asyncio.run(_tool_generate_image({"prompt": "x"}))
        assert "[错误]" in r
        assert "未保存到本地" in r
        assert "图片生成成功" not in r    # 绝不出现成功字样
        assert "https://example.com/img.png" in r  # URL 仍可用

    def test_generate_video_completed(self):
        from tools.agnes_media import _tool_generate_video
        captured = {}

        async def fake_post(url, payload, timeout=60.0):
            captured.update(payload)
            return {"id": "video_1"}

        async def fake_get(url, timeout=30.0):
            return {"status": "completed", "progress": 100, "url": "https://example.com/v.mp4"}

        with patch("tools.agnes_media._post_json", new=fake_post), \
             patch("tools.agnes_media._get_json", new=fake_get), \
             patch("tools.agnes_media._download_async", return_value="D:\\x\\v.mp4"), \
             patch("tools.agnes_media._real_size", return_value=2920440), \
             patch("tools.agnes_media._VIDEO_POLL_ATTEMPTS", 1), \
             patch("tools.agnes_media._wait_video_slot", new=lambda k: __import__("asyncio").sleep(0)), \
             patch("tools.agnes_media._VIDEO_POLL_INTERVAL", 0.0):
            r = asyncio.run(_tool_generate_video({"prompt": "sunset", "duration": 5}))
        assert "视频生成完成" in r
        assert "https://example.com/v.mp4" in r
        assert "D:\\x\\v.mp4" in r
        assert "2920440 字节" in r       # A-048: 真实文件大小
        assert captured["model"] == "agnes-video-v2.0"
        assert captured["duration"] == 5

    def test_generate_video_completed_download_failure(self):
        """A-048: 视频完成但下载失败 → [错误] + 未保存到本地（不给模型编造空间）"""
        from tools.agnes_media import _tool_generate_video

        async def fake_post(url, payload, timeout=60.0):
            return {"id": "video_1"}

        async def fake_get(url, timeout=30.0):
            return {"status": "completed", "progress": 100, "url": "https://e.com/v.mp4"}

        with patch("tools.agnes_media._post_json", new=fake_post), \
             patch("tools.agnes_media._get_json", new=fake_get), \
             patch("tools.agnes_media._download_async", return_value=""), \
             patch("tools.agnes_media._VIDEO_POLL_ATTEMPTS", 1), \
             patch("tools.agnes_media._wait_video_slot", new=lambda k: __import__("asyncio").sleep(0)), \
             patch("tools.agnes_media._VIDEO_POLL_INTERVAL", 0.0):
            r = asyncio.run(_tool_generate_video({"prompt": "sunset"}))
        assert "[错误]" in r
        assert "未保存到本地" in r
        assert "视频生成完成" not in r    # A-048（review 修复）：下载失败不用"完成"字样
        assert "URL: https://e.com/v.mp4" in r

    def test_video_status_completed_download_failure(self):
        """A-048（review 修复）：status 查询完成但下载失败 → 无"已完成"字样"""
        from tools.agnes_media import _tool_video_status

        async def fake_get(url, timeout=30.0):
            return {"status": "completed", "progress": 100, "url": "https://e.com/v.mp4"}

        with patch("tools.agnes_media._get_json", new=fake_get), \
             patch("tools.agnes_media._download_async", return_value=""):
            r = asyncio.run(_tool_video_status({"video_id": "v9"}))
        assert "[错误]" in r
        assert "未保存到本地" in r
        assert "视频已完成" not in r
        assert "URL: https://e.com/v.mp4" in r

    def test_generate_video_still_processing(self):
        """A-048 核心回归：未完成必须明确"未完成"（此前"已轮询约 5 分钟仍未完成"
        语义模糊，弱模型随后编造完成）"""
        from tools.agnes_media import _tool_generate_video

        async def fake_post(url, payload, timeout=60.0):
            return {"id": "video_2"}

        async def fake_get(url, timeout=30.0):
            return {"status": "processing", "progress": 42}

        with patch("tools.agnes_media._post_json", new=fake_post), \
             patch("tools.agnes_media._get_json", new=fake_get), \
             patch("tools.agnes_media._VIDEO_POLL_ATTEMPTS", 1), \
             patch("tools.agnes_media._wait_video_slot", new=lambda k: __import__("asyncio").sleep(0)), \
             patch("tools.agnes_media._VIDEO_POLL_INTERVAL", 0.0):
            r = asyncio.run(_tool_generate_video({"prompt": "sunset"}))
        assert "[进行中]" in r
        assert "video_2" in r
        assert "未完成" in r
        assert "agnes_video_status" in r  # 未完成给出查询指引

    def test_video_status_tool(self):
        from tools.agnes_media import _tool_video_status
        assert "缺少 video_id" in asyncio.run(_tool_video_status({}))

        async def fake_get(url, timeout=30.0):
            return {"status": "completed", "progress": 100, "url": "https://e.com/v.mp4"}

        with patch("tools.agnes_media._get_json", new=fake_get), \
             patch("tools.agnes_media._download_async", return_value="D:\\local\\v.mp4"), \
             patch("tools.agnes_media._real_size", return_value=999):
            r = asyncio.run(_tool_video_status({"video_id": "v1"}))
        assert "视频已完成" in r and "https://e.com/v.mp4" in r
        assert "999 字节" in r

        async def fake_failed(url, timeout=30.0):
            return {"status": "failed", "error": "GPU 不足"}

        with patch("tools.agnes_media._get_json", new=fake_failed):
            r = asyncio.run(_tool_video_status({"video_id": "v2"}))
        assert "生成失败" in r and "GPU 不足" in r

        async def fake_processing(url, timeout=30.0):
            return {"status": "queued", "progress": 0}

        with patch("tools.agnes_media._get_json", new=fake_processing):
            r = asyncio.run(_tool_video_status({"video_id": "v3"}))
        assert "[进行中]" in r and "未完成" in r

    def test_video_completed_no_url_honest_feedback(self):
        """A-048-R2（真实调用发现）：平台完成态响应无 url 字段 → 如实反馈任务 ID，
        绝不编造成品路径"""
        from tools.agnes_media import _tool_generate_video, _tool_video_status

        async def fake_post(url, payload, timeout=60.0):
            return {"id": "video_nourl"}

        async def fake_get(url, timeout=30.0):
            return {"status": "completed", "progress": 100}  # 无 url 字段

        with patch("tools.agnes_media._post_json", new=fake_post), \
             patch("tools.agnes_media._get_json", new=fake_get), \
             patch("tools.agnes_media._VIDEO_POLL_ATTEMPTS", 1), \
             patch("tools.agnes_media._wait_video_slot", new=lambda k: __import__("asyncio").sleep(0)), \
             patch("tools.agnes_media._VIDEO_POLL_INTERVAL", 0.0):
            r = asyncio.run(_tool_generate_video({"prompt": "x"}))
        assert "[错误]" in r
        assert "video_nourl" in r
        assert "未包含成品 URL" in r

        with patch("tools.agnes_media._get_json", new=fake_get):
            r2 = asyncio.run(_tool_video_status({"video_id": "v9"}))
        assert "未包含成品 URL" in r2

    def test_video_status_endpoint_format(self):
        """A-048-R3（真实调用根因）：video_ 开头走推荐端点 /agnesapi?video_id=，
        task_ 开头走兼容端点 /v1/videos/{id}"""
        from tools.agnes_media import _video_status_url, _POLL_BASE, _API_BASE
        url = _video_status_url("video_abc123")
        assert url == f"{_POLL_BASE}?video_id=video_abc123"
        assert url.startswith("https://api.agnes-ai.cn/agnesapi?")
        url2 = _video_status_url("task_abc")
        assert url2 == f"{_API_BASE}/videos/task_abc"

    def test_extract_video_url_field_compat(self):
        """A-048-R3：完成态 URL 提取兼容官方文档各字段名"""
        from tools.agnes_media import _extract_video_url
        assert _extract_video_url({"url": "https://x/v.mp4"}) == "https://x/v.mp4"
        assert _extract_video_url({"video_url": "https://x/v2.mp4"}) == "https://x/v2.mp4"
        assert _extract_video_url({"metadata": {"url": "https://x/m.mp4"}}) == "https://x/m.mp4"
        assert _extract_video_url({"remixed_from_video_id": "https://x/r.mp4"}) == "https://x/r.mp4"
        # 非 http 的 remixed_from_video_id（如内部 ID）不当作 URL
        assert _extract_video_url({"remixed_from_video_id": "video_zzz"}) == ""
        assert _extract_video_url({"status": "completed"}) == ""
        assert _extract_video_url(None) == ""

    def test_generate_video_prefers_video_id(self):
        """A-048-R3（真实调用根因）：创建响应同时含 id(task_xxx) 与 video_id(video_xxx)
        时必须优先用 video_id（否则永远拿不到成品 URL）"""
        from tools.agnes_media import _tool_generate_video
        captured = {}

        async def fake_post(url, payload, timeout=60.0):
            return {"id": "task_abc", "video_id": "video_xyz", "task_id": "task_abc"}

        async def fake_get(url, timeout=30.0):
            captured["queried_url"] = url
            return {"status": "processing", "progress": 10}

        with patch("tools.agnes_media._post_json", new=fake_post), \
             patch("tools.agnes_media._get_json", new=fake_get), \
             patch("tools.agnes_media._VIDEO_POLL_ATTEMPTS", 1), \
             patch("tools.agnes_media._wait_video_slot", new=lambda k: __import__("asyncio").sleep(0)), \
             patch("tools.agnes_media._VIDEO_POLL_INTERVAL", 0.0):
            r = asyncio.run(_tool_generate_video({"prompt": "x"}))
        assert "video_xyz" in captured["queried_url"]  # 用 video_id 查询
        assert "task_abc" not in captured["queried_url"]

    def test_encode_image_and_limits(self, tmp_path):
        from tools.agnes_media import _encode_image, _MAX_IMAGE_BYTES
        p = tmp_path / "a.png"
        p.write_bytes(b"123")
        data_url = _encode_image(str(p))
        assert data_url.startswith("data:image/png;base64,")

        try:
            _encode_image(str(tmp_path / "none.png"))
            assert False, "应抛 ValueError"
        except ValueError as e:
            assert "不存在" in str(e)

        with patch("tools.agnes_media._MAX_IMAGE_BYTES", 2):
            big = tmp_path / "big.png"
            big.write_bytes(b"toolarge")
            try:
                _encode_image(str(big))
                assert False, "应抛 ValueError"
            except ValueError as e:
                assert "8MB" in str(e)

    def test_register_tools_idempotent(self):
        from tools.registry import reset_registry, get_registry
        from tools.agnes_media import register_agnes_media_tools
        reset_registry()
        try:
            n1 = register_agnes_media_tools()
            assert n1 == 5  # A-048: +agnes_prompt_build; A-059: +video_concat
            names = get_registry().list_tool_names()
            assert "agnes_prompt_build" in names
            assert "agnes_generate_image" in names
            assert "agnes_generate_video" in names
            assert "agnes_video_status" in names
            assert register_agnes_media_tools() == 0  # 同名拒绝覆盖（注册表铁律）
        finally:
            reset_registry()


class TestAgnesLocalDownload:
    """A-040: 生成结果直接下载到本地 data/generated/"""

    def test_image_tool_returns_local_path(self, tmp_path):
        from tools.agnes_media import _tool_generate_image
        import asyncio

        async def fake_post(url, payload, timeout=60.0):
            return {"data": [{"url": "https://example.com/img.png"}]}

        with patch("tools.agnes_media._post_json", new=fake_post), \
             patch("tools.agnes_media._download_async", return_value=str(tmp_path / "local.png")), \
             patch("tools.agnes_media._wait_video_slot", new=lambda k: __import__("asyncio").sleep(0)), \
             patch("tools.agnes_media._real_size", return_value=100):
            r = asyncio.run(_tool_generate_image({"prompt": "x"}))
        assert "本地文件" in r
        assert "local.png" in r
        assert "URL:" in r

    def test_image_tool_fallback_when_download_fails(self):
        """A-048: 下载失败 → [错误] + 未保存到本地 + URL（不再返回"生成成功"）"""
        from tools.agnes_media import _tool_generate_image
        import asyncio

        async def fake_post(url, payload, timeout=60.0):
            return {"data": [{"url": "https://example.com/img.png"}]}

        with patch("tools.agnes_media._post_json", new=fake_post), \
             patch("tools.agnes_media._wait_video_slot", new=lambda k: __import__("asyncio").sleep(0)), \
             patch("tools.agnes_media._download_async", return_value=""):
            r = asyncio.run(_tool_generate_image({"prompt": "x"}))
        assert "[错误]" in r
        assert "未保存到本地" in r
        assert "URL: https://example.com/img.png" in r

    def test_download_async_saves_file(self, tmp_path):
        from tools.agnes_media import _download_async
        import asyncio
        import httpx

        def handler(request):
            return httpx.Response(200, content=b"PNGDATA", headers={"content-type": "image/png"})

        real_async_client = httpx.AsyncClient  # 保存真实类，防 mock 递归

        def make_client(**kwargs):
            kwargs.pop("transport", None)
            return real_async_client(transport=httpx.MockTransport(handler), **kwargs)

        with patch("tools.agnes_media._GENERATED_DIR", tmp_path), \
             patch.object(httpx, "AsyncClient", side_effect=make_client):
            local = asyncio.run(_download_async("https://example.com/a.png", "images"))
        from pathlib import Path
        p = Path(local)
        assert p.exists() and p.read_bytes() == b"PNGDATA"
        assert "images" in str(p)

    def test_video_status_completed_downloads(self):
        from tools.agnes_media import _tool_video_status
        import asyncio

        async def fake_get(url, timeout=30.0):
            return {"status": "completed", "progress": 100, "url": "https://e.com/v.mp4"}

        with patch("tools.agnes_media._get_json", new=fake_get), \
             patch("tools.agnes_media._download_async", return_value="D:\\local\\v.mp4"), \
             patch("tools.agnes_media._real_size", return_value=500):
            r = asyncio.run(_tool_video_status({"video_id": "v1"}))
        assert "本地文件" in r
        assert "D:\\local\\v.mp4" in r
        assert "500 字节" in r


class TestImageArgNormalization:
    """A-048-R5：image 参数归一化——URL 透传 / 本地路径 base64"""

    def test_url_passthrough(self):
        from tools.agnes_media import _encode_image_arg
        url = "https://example.com/a.png"
        assert _encode_image_arg(url) == url  # 原样透传

    def test_local_path_base64(self, tmp_path):
        from tools.agnes_media import _encode_image_arg
        p = tmp_path / "a.png"
        p.write_bytes(b"123")
        data = _encode_image_arg(str(p))
        assert data.startswith("data:image/png;base64,")

    def test_invalid_path_raises(self):
        from tools.agnes_media import _encode_image_arg
        try:
            _encode_image_arg("C:/no/such.png")
            assert False, "应抛 ValueError"
        except ValueError as e:
            assert "不存在" in str(e)

    def test_generate_image_accepts_url(self):
        """图生图传 URL → 透传（此前报'图片文件不存在'）"""
        from tools.agnes_media import _tool_generate_image
        captured = {}

        async def fake_post(url, payload, timeout=60.0):
            captured.update(payload)
            return {"data": [{"url": "https://example.com/out.png"}]}

        with patch("tools.agnes_media._post_json", new=fake_post),              patch("tools.agnes_media._download_async", return_value="D:/x/out.png"),              patch("tools.agnes_media._real_size", return_value=1):
            r = asyncio.run(_tool_generate_image(
                {"prompt": "x", "image": "https://example.com/src.png"}))
        assert captured["image"] == ["https://example.com/src.png"]  # URL 数组透传
        assert "图片生成成功" in r



class TestMediaCache:
    """A-073: 生成结果内容寻址缓存（合规降需——命中不调 API，官方推荐手段）"""

    def test_cache_key_stable_and_distinct(self):
        from tools import agnes_media as M
        k1 = M._media_cache_key("image", "a cat", "2K", M._IMAGE_MODEL, "")
        k2 = M._media_cache_key("image", "a cat", "2K", M._IMAGE_MODEL, "")
        k3 = M._media_cache_key("image", "a dog", "2K", M._IMAGE_MODEL, "")
        assert k1 == k2 and k1 != k3

    def test_image_cache_hit_skips_api(self):
        """缓存命中 → 不调用 API（mock _post_json 返回 error 也不触发）"""
        from tools import agnes_media as M
        cache_key = M._media_cache_key("image", "cached test", "2K", M._IMAGE_MODEL, "")
        cp = M._media_cache_path("image", cache_key)
        cp.parent.mkdir(parents=True, exist_ok=True)
        cp.write_bytes(b"PNG-FAKE")
        calls = []

        async def fake_post(url, payload, timeout=60.0):
            calls.append(url)
            return {"__error": "不应被调用"}

        with patch("tools.agnes_media._post_json", new=fake_post):
            r = asyncio.run(M._tool_generate_image({"prompt": "cached test", "size": "2K"}))
        assert "命中本地缓存" in r and "未调用 API" in r
        assert calls == []

    def test_image_cache_refresh_bypasses(self):
        """refresh=true → 绕过缓存重新生成"""
        from tools import agnes_media as M
        cache_key = M._media_cache_key("image", "cached test", "2K", M._IMAGE_MODEL, "")
        cp = M._media_cache_path("image", cache_key)
        cp.parent.mkdir(parents=True, exist_ok=True)
        cp.write_bytes(b"PNG-FAKE")
        calls = []

        async def fake_post(url, payload, timeout=60.0):
            calls.append(url)
            return {"data": []}  # 走到"缺少 URL"分支即可证明绕过了缓存

        with patch("tools.agnes_media._post_json", new=fake_post),              patch("tools.agnes_media._wait_video_slot", new=lambda k: __import__("asyncio").sleep(0)):
            r = asyncio.run(M._tool_generate_image({"prompt": "cached test", "size": "2K", "refresh": "true"}))
        assert "未调用 API" not in r
        assert calls, "refresh 应调用 API"

    def test_video_cache_hit_skips_api(self):
        """视频缓存命中 → 不调 API（不消耗视频配额）"""
        from tools import agnes_media as M
        cache_key = M._media_cache_key("video", "cached vid", "1280x720", M._VIDEO_MODEL, "")
        cp = M._media_cache_path("video", cache_key)
        cp.parent.mkdir(parents=True, exist_ok=True)
        cp.write_bytes(b"FAKE-MP4")
        calls = []

        async def fake_post(url, payload, timeout=60.0):
            calls.append(url)
            return {"__error": "不应被调用"}

        with patch("tools.agnes_media._post_json", new=fake_post):
            r = asyncio.run(M._tool_generate_video({"prompt": "cached vid", "duration": 5}))
        assert "命中本地缓存" in r
        assert calls == []


class TestRefFrameInjection:
    """A-083: 链式参考帧强制注入 + 图生视频人物保持指令"""

    def test_video_tool_appends_character_keep_note(self):
        """有 image 时 prompt 自动追加人物保持指令（防'一会男人一会女人'）"""
        from tools.agnes_media import _tool_generate_video
        calls = {}

        async def fake_post(url, payload, timeout=60.0):
            calls["payload"] = payload
            return {"video_id": "video_x", "id": "task_x"}

        async def fake_get(url):
            return {"status": "completed", "progress": 100,
                    "video_url": "https://x/v.mp4", "url": "https://x/v.mp4"}

        with patch("tools.agnes_media._post_json", side_effect=fake_post),              patch("tools.agnes_media._get_json", side_effect=fake_get),              patch("tools.agnes_media._download_async", return_value="D:/x/v.mp4"),              patch("tools.agnes_media._real_size", return_value=123),              patch("tools.agnes_media._wait_video_slot", new=lambda k: __import__("asyncio").sleep(0)),              patch("tools.agnes_media._VIDEO_POLL_ATTEMPTS", 1),              patch("tools.agnes_media._VIDEO_POLL_INTERVAL", 0.0),              patch("tools.agnes_media._encode_image_arg", return_value="data:image/png;base64,xxx"):
            asyncio.run(_tool_generate_video({"prompt": "男人继续说话", "image": "D:/f.png", "duration": 5}))
        assert "IMPORTANT: Keep the SAME characters" in calls["payload"]["prompt"]

    def test_ref_frame_auto_injected_when_missing(self):
        """模型调 agnes_generate_video 未传 image → 参考帧自动注入（contextvar）"""
        from core.agent_context import current_ref_frame
        from core.llm import _execute_pending_tools
        from core.agent import Agent as AgentCls
        from tools.registry import get_registry
        from tools.agnes_media import register_agnes_media_tools
        register_agnes_media_tools()
        from core.sandbox import get_sandbox_manager
        mgr = get_sandbox_manager()
        if "agnes_*" not in mgr.config.auto_approve_tools:
            mgr.config.auto_approve_tools = list(mgr.config.auto_approve_tools) + ["agnes_*"]
        agent = AgentCls(name="W", role="w", model_choice="api:x")
        got = {}

        async def fake_call(name, args):
            got["args"] = args
            return "视频生成完成"

        reg = get_registry()
        with patch.object(reg, "call_tool", side_effect=fake_call):
            tok = current_ref_frame.set("D:/frames/frame_prev.png")
            try:
                asyncio.run(_execute_pending_tools(agent, [], [
                    {"id": "c1", "type": "function",
                     "function": {"name": "agnes_generate_video", "arguments": '{"prompt": "延续画面"}'}}
                ]))
            finally:
                current_ref_frame.reset(tok)
        assert got["args"].get("image") == "D:/frames/frame_prev.png", got

    def test_ref_frame_does_not_override_explicit_image(self):
        """模型显式传 image → 不覆盖（尊重模型意图）"""
        from core.agent_context import current_ref_frame
        from core.llm import _execute_pending_tools
        from core.agent import Agent as AgentCls
        from tools.registry import get_registry
        from tools.agnes_media import register_agnes_media_tools
        register_agnes_media_tools()
        from core.sandbox import get_sandbox_manager
        mgr = get_sandbox_manager()
        if "agnes_*" not in mgr.config.auto_approve_tools:
            mgr.config.auto_approve_tools = list(mgr.config.auto_approve_tools) + ["agnes_*"]
        agent = AgentCls(name="W", role="w", model_choice="api:x")
        got = {}

        async def fake_call(name, args):
            got["args"] = args
            return "视频生成完成"

        reg = get_registry()
        with patch.object(reg, "call_tool", side_effect=fake_call):
            tok = current_ref_frame.set("D:/frames/prev.png")
            try:
                asyncio.run(_execute_pending_tools(agent, [], [
                    {"id": "c2", "type": "function",
                     "function": {"name": "agnes_generate_video", "arguments": '{"prompt": "x", "image": "D:/my.png"}'}}
                ]))
            finally:
                current_ref_frame.reset(tok)
        assert got["args"].get("image") == "D:/my.png"


class TestVideoThrottle:
    """A-072: 视频提交主动节流（1 RPM 滑动窗口）"""

    def test_video_throttle_same_key(self):
        """同一 key 连续提交 → 第二次等满窗口（主动节流；A-074: 65s 缓冲 + 抖动）"""
        from tools import agnes_media as M
        import time as _t
        with patch("random.uniform", return_value=0.0), patch.object(M, "_VIDEO_MIN_INTERVAL", 3.0):
            M._last_video_submit.clear()
            t0 = _t.time()
            asyncio.run(M._wait_video_slot("throttle_key_123"))
            assert _t.time() - t0 < 0.5  # 首次不等待
            # 注意：结束后会恢复（pytest 进程内改模块属性有泄漏风险，此处用 with patch.object 更安全
            t0 = _t.time()
            asyncio.run(M._wait_video_slot("throttle_key_123"))
            d = _t.time() - t0
            assert 2.5 <= d <= 4.0, d  # 等满窗口（65s 缓冲逻辑）

    def test_video_throttle_jitter_applied(self):
        """A-074: 随机抖动注入（破坏均匀流水线指纹）——抖动被加进等待时长"""
        from tools import agnes_media as M
        import time as _t
        with patch("random.uniform", return_value=10.0), patch.object(M, "_VIDEO_MIN_INTERVAL", 3.0):
            M._last_video_submit.clear()
            asyncio.run(M._wait_video_slot("jitter_key"))
            t0 = _t.time()
            asyncio.run(M._wait_video_slot("jitter_key"))
            d = _t.time() - t0
            assert 12.5 <= d <= 14.0, d  # 3s 窗口 + 10s 抖动

    def test_video_throttle_diff_key_independent(self):
        """不同 key 独立窗口（多账号并行不受阻塞）"""
        from tools import agnes_media as M
        import time as _t
        M._last_video_submit.clear()
        asyncio.run(M._wait_video_slot("key_a"))
        t0 = _t.time()
        asyncio.run(M._wait_video_slot("key_b"))
        assert _t.time() - t0 < 0.5

class TestAgnesPerAgentKey:
    """A-048-R4：按调用方 Agent 的 model_choice 解析各自 Agnes 账号密钥"""

    def test_resolves_key_by_agent_provider(self):
        """Agent model_choice=api:Agnes-5 → 用 Agnes-5 的 key（而非全局第一个）"""
        from tools.agnes_media import _get_api_key
        from core.agent_context import current_model_choice
        providers = {
            "Agnes-1": {"api_base": "https://api.agnes-ai.cn/v1", "api_key": "sk-AAAA"},
            "Agnes-5": {"api_base": "https://api.agnes-ai.cn/v1", "api_key": "sk-BBBB"},
        }
        import os
        os.environ.pop("HERMES_CUSTOM_API_AGNES_AI_CN_API_KEY", None)
        with patch("core.encryption.decrypt", return_value=providers), \
             patch("core.encryption.decrypt", return_value=providers):
            token = current_model_choice.set("api:Agnes-5")
            try:
                key = _get_api_key()
            finally:
                current_model_choice.reset(token)
        assert key == "sk-BBBB"  # 按 Agent 分配，非全局第一个 sk-AAAA

    def test_fallback_first_match_without_context(self):
        """无 Agent 上下文（直调）→ 回退任意第一个 agnes-ai provider"""
        from tools.agnes_media import _get_api_key
        from core.agent_context import current_model_choice
        providers = {
            "Agnes-1": {"api_base": "https://api.agnes-ai.cn/v1", "api_key": "sk-AAAA"},
            "Elysia": {"api_base": "https://api.agnes-ai.cn/v1", "api_key": "sk-CCCC"},
        }
        import os
        os.environ.pop("HERMES_CUSTOM_API_AGNES_AI_CN_API_KEY", None)
        token = current_model_choice.set("")
        try:
            with patch("core.encryption.decrypt", return_value=providers), \
                 patch("core.encryption.decrypt", return_value=providers):
                key = _get_api_key()
        finally:
            current_model_choice.reset(token)
        assert key == "sk-AAAA"

    def test_env_var_wins_over_agent(self):
        """显式环境变量仍优先（显式设置 > Agent 分配）"""
        from tools.agnes_media import _get_api_key, _ENV_KEY
        from core.agent_context import current_model_choice
        import os
        os.environ[_ENV_KEY] = "sk-ENVVAR"
        providers = {"Agnes-5": {"api_base": "https://api.agnes-ai.cn/v1", "api_key": "sk-BBBB"}}
        token = current_model_choice.set("api:Agnes-5")
        try:
            with patch("core.encryption.decrypt", return_value=providers):
                assert _get_api_key() == "sk-ENVVAR"
        finally:
            current_model_choice.reset(token)
            os.environ.pop(_ENV_KEY, None)

    def test_execute_pending_tools_sets_context(self):
        """core/llm._execute_pending_tools 执行工具时设置 Agent 上下文，结束清理"""
        from core.agent_context import current_model_choice
        from core.agent import Agent
        from tools.registry import reset_registry, get_registry, Tool
        reset_registry()
        try:
            seen = {}

            async def probe(args):
                seen["mc"] = current_model_choice.get()
                return "ok"

            get_registry().register(Tool(name="probe_ctx", description="d",
                                         parameters={"type": "object", "properties": {}},
                                         execute_fn=probe, permissions=[]))
            import asyncio
            agent = Agent(name="A", role="r", model_choice="api:Agnes-5")
            from core.llm import _execute_pending_tools
            asyncio.run(_execute_pending_tools(
                agent, [], [{"id": "t1", "function": {"name": "probe_ctx", "arguments": "{}"}}]))
            assert seen["mc"] == "api:Agnes-5"  # 工具内可见 Agent 上下文
            assert current_model_choice.get() == ""  # 结束后清理
        finally:
            reset_registry()


class TestVideoConcat:
    """A-059: 视频拼接工具"""

    def test_requires_two_videos(self):
        from tools.agnes_media import _tool_video_concat
        assert "[错误]" in asyncio.run(_tool_video_concat({"videos": ["a.mp4"]}))
        assert "[错误]" in asyncio.run(_tool_video_concat({}))
        assert "[错误]" in asyncio.run(_tool_video_concat({"videos": "not-list"}))

    def test_missing_file_rejected(self, tmp_path):
        from tools.agnes_media import _tool_video_concat
        r = asyncio.run(_tool_video_concat({
            "videos": [str(tmp_path / "nope1.mp4"), str(tmp_path / "nope2.mp4")]}))
        assert "不存在或非 mp4" in r

    def test_register_includes_concat(self):
        from tools.registry import reset_registry, get_registry
        from tools.agnes_media import register_agnes_media_tools
        reset_registry()
        try:
            n = register_agnes_media_tools()
            assert n == 5  # A-059: 新增 video_concat
            names = get_registry().list_tool_names()
            assert "video_concat" in names
        finally:
            reset_registry()


class TestAgnesPromptBuild:
    """A-048: 配套提示词工具（规则式，确定性输出）"""

    def test_image_prompt_build(self):
        from tools.agnes_media import _tool_prompt_build
        r = asyncio.run(_tool_prompt_build({
            "media_type": "image", "subject": "清纯女大学生在校园散步",
            "scene": "林荫道", "style": "清新",
        }))
        assert "提示词构建完成（image）" in r
        assert "清纯女大学生在校园散步" in r
        assert "场景：林荫道" in r
        assert "风格：清新" in r
        assert "杜绝塑料感或洋娃娃感" in r  # FACE_STANDARD 浓缩段
        assert "size=2K" in r and "ratio=1:1" in r

    def test_video_prompt_build(self):
        from tools.agnes_media import _tool_prompt_build
        r = asyncio.run(_tool_prompt_build({
            "media_type": "video", "subject": "girl walking", "duration": 8,
        }))
        assert "提示词构建完成（video）" in r
        assert "girl walking" in r
        assert "duration=8" in r
        assert "1280x720" in r
        assert "agnes_generate_video" in r

    def test_prompt_build_face_quality_off(self):
        from tools.agnes_media import _tool_prompt_build
        r = asyncio.run(_tool_prompt_build({
            "media_type": "image", "subject": "风景", "face_quality": False,
        }))
        assert "杜绝塑料感" not in r

    def test_prompt_build_face_heuristic(self):
        """A-048（review 修复）：face_quality 未传时按主体启发式——
        人物主体自动追加脸部段，风景/产品不追加"""
        from tools.agnes_media import _tool_prompt_build
        # 人物主体（含"女"）→ 自动追加
        r1 = asyncio.run(_tool_prompt_build({
            "media_type": "image", "subject": "清纯女大学生在校园散步",
        }))
        assert "杜绝塑料感" in r1
        # 风景主体 → 不追加（不污染）
        r2 = asyncio.run(_tool_prompt_build({
            "media_type": "image", "subject": "清晨的山间湖泊日出",
        }))
        assert "杜绝塑料感" not in r2
        # 英文人物词 → 自动追加
        r3 = asyncio.run(_tool_prompt_build({
            "media_type": "image", "subject": "a portrait of an old man",
        }))
        assert "杜绝塑料感" in r3

    def test_download_cache_reuse(self, tmp_path):
        """A-048（review 修复）：同 URL 已下载过（status 重复轮询）复用缓存不重复下载"""
        from tools.agnes_media import _download_async
        import httpx

        url = "https://example.com/cache_me.mp4"
        calls = {"n": 0}

        def handler(request):
            calls["n"] += 1
            return httpx.Response(200, content=b"CACHED")

        real_async_client = httpx.AsyncClient

        def make_client(**kwargs):
            kwargs.pop("transport", None)
            return real_async_client(transport=httpx.MockTransport(handler), **kwargs)

        with patch("tools.agnes_media._GENERATED_DIR", tmp_path), \
             patch.object(httpx, "AsyncClient", side_effect=make_client):
            p1 = asyncio.run(_download_async(url, "videos"))
            p2 = asyncio.run(_download_async(url, "videos"))  # 第二次应命中缓存
        assert p1 == p2
        assert calls["n"] == 1  # 只实际下载一次

    def test_prompt_build_errors(self):
        from tools.agnes_media import _tool_prompt_build
        assert "[错误]" in asyncio.run(_tool_prompt_build({"media_type": "xxx", "subject": "a"}))
        assert "[错误]" in asyncio.run(_tool_prompt_build({"media_type": "image"}))  # 缺 subject
        assert "[错误]" in asyncio.run(_tool_prompt_build({}))

    def test_prompt_build_invalid_params_normalized(self):
        """非法 size/ratio/duration 归一化为默认（不报错，保持工具可用）"""
        from tools.agnes_media import _tool_prompt_build
        r = asyncio.run(_tool_prompt_build({
            "media_type": "image", "subject": "x", "size": "9K", "ratio": "5:5",
        }))
        assert "size=2K" in r and "ratio=1:1" in r
        r2 = asyncio.run(_tool_prompt_build({
            "media_type": "video", "subject": "x", "duration": 999,
        }))
        assert "duration=18" in r2  # 钳制到上限
