"""
slime 一体化启动器
- 输入 slime → 后台起 server → 显示启动情况 → 进 CLI → 退出时自动杀 server + 释放端口
- 用 Python subprocess 管理进程,绕开 cmd/PowerShell 的兼容性问题
- 三重清理保证:atexit + SIGINT + try/finally
"""
import os
import sys
import time
import json
import atexit
import signal
import socket
import subprocess
import urllib.request
from pathlib import Path

SLIME_DIR = Path(__file__).resolve().parent
SERVER_SCRIPT = SLIME_DIR / "slime_server.py"
CLI_SCRIPT = SLIME_DIR / "slime_cli.py"
try:
    PORT = int(os.environ.get("SLIME_PORT", "19000"))
except (ValueError, TypeError):
    PORT = 19000
HEALTH_URL = f"http://127.0.0.1:{PORT}/health"
# A-092: 90s 覆盖 MCP 首启（uvx serena/headroom/browser_use 首次运行需下载依赖，
# 可达 30-60s+；此前 20s < MCP start_all 60s 超时 → 首次启动必然报"服务启动超时"）
READY_TIMEOUT = 90  # 秒


def _port_in_use(port: int) -> bool:
    """检测端口是否被占用"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _kill_port(port: int):
    """杀掉占用指定端口的 LISTENING 进程(清理残留 server)。

    A-020: 仅当进程镜像名是 python 时才杀 —— 端口 19000 可能被无关程序占用，
    无校验 taskkill 会误杀用户其他服务。"""
    try:
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            timeout=5,
            errors='replace',  # 忽略无法解码的字符
        )
        killed = []
        if result.stdout:
            for line in result.stdout.splitlines():
                if f":{port}" in line and "LISTENING" in line.upper():
                    parts = line.split()
                    if parts:
                        pid = parts[-1]
                        if not (pid.isdigit() and int(pid) != os.getpid()):
                            continue
                        if not _is_python_process(pid):
                            print(
                                f"[slime] 端口 {port} 被非 slime 进程占用 (PID {pid})，"
                                f"不自动清理 —— 请手动处理或改用 SLIME_PORT"
                            )
                            continue
                        subprocess.run(
                            ["taskkill", "/F", "/PID", pid],
                            capture_output=True,
                            timeout=5,
                        )
                        killed.append(pid)
        if killed:
            print(f"[slime] 已清理残留进程 (PID: {', '.join(killed)})")
    except BaseException as e:
        # A-100: 必须用 BaseException——KeyboardInterrupt 是 BaseException 非 Exception，
        # Ctrl+C 退出时 atexit 回调里 _kill_port 会抛 KeyboardInterrupt（Python 3.12
        # 中断 subprocess 的 stdout_thread.join），此前导致 "Exception ignored in atexit callback"
        print(f"[slime] 清理端口失败: {e}")


def _is_python_process(pid: str) -> bool:
    """校验 PID 镜像名是 python（tasklist CSV）。校验失败返回 False（不误杀）。"""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        first = out.splitlines()[0] if out.splitlines() else ""
        return "python" in first.lower()
    except Exception:
        return False


def _wait_server_ready(timeout: int = READY_TIMEOUT) -> bool:
    """轮询 /health 直到就绪或超时。

    A-071: 必须验证响应**是 slime server**（JSON status=ok 且含 agent_count）——
    此前只看 HTTP 200，端口被其他程序占用（如 PID 25396 对任意路径回 200）
    会被误判"服务已就绪"，随后 CLI API 调用收到占用程序的 401。
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(HEALTH_URL, timeout=1) as resp:
                if resp.status == 200:
                    body = resp.read().decode("utf-8", "replace")
                    try:
                        data = json.loads(body)
                    except Exception:
                        data = None
                    # slime /health 返回 {"status": "ok", "agent_count": N}
                    if isinstance(data, dict) and data.get("status") == "ok" \
                            and "agent_count" in data:
                        return True
        except Exception:
            time.sleep(0.5)
    return False


def _kill_process_tree(pid: int):
    """杀掉整个进程树(Windows: taskkill /F /T)"""
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True, timeout=5,
        )
    except Exception:
        pass


def _is_configured() -> bool:
    """
    检测是否已完成首次配置:
    - agents.json 非空(至少有一个 Agent)
    - providers.enc.json 能解密出非空 dict(至少有一个 Provider)
    """
    # 检查 agents.json
    agents_path = SLIME_DIR / "config" / "agents.json"
    if not agents_path.exists():
        return False
    try:
        import json
        data = json.loads(agents_path.read_text(encoding="utf-8"))
        if not data:  # 空列表 []
            return False
    except Exception:
        return False

    # 检查 providers.enc.json 能否解密出非空 dict
    try:
        # A-020: 直接传绝对路径，不用 chdir 改全局状态（异常时 cwd 不会残留变更）
        sys.path.insert(0, str(SLIME_DIR))
        from core.encryption import decrypt
        providers = decrypt(str(SLIME_DIR / "config" / "providers.enc.json"))
        if not providers:  # None 或 {}
            return False
    except Exception:
        return False

    return True


def main():
    server_proc = None

    def _cleanup():
        nonlocal server_proc
        # A-100: atexit 回调绝不抛异常（KeyboardInterrupt/SystemExit 都会导致
        # "Exception ignored in atexit callback"）——整体防护
        try:
            if server_proc and server_proc.poll() is None:
                _kill_process_tree(server_proc.pid)
                server_proc = None
            # 兜底:再清一次端口,防止子进程没杀干净
            _kill_port(PORT)
        except BaseException as e:
            print(f"[slime] 退出清理异常（忽略）: {e}")

    atexit.register(_cleanup)

    # Ctrl+C 不立即退出,让子进程(CLI)自己处理
    # 仅在 CLI 真正退出后由 atexit 清理 server

    # 1. 端口已被占用 → 先清理(可能是上次残留的 server)
    if _port_in_use(PORT):
        print(f"[slime] 端口 {PORT} 被占用,正在清理残留进程...")
        _kill_port(PORT)
        time.sleep(1)
        # A-071: 清理后仍被占用（非 slime 程序，如重启后自启的 PID 25396）
        # → 立即报错退出，不启动 server（否则新 server 绑定失败，且 /health 200
        #   来自占用程序导致"假就绪"，CLI 随后收到占用程序的 401）
        if _port_in_use(PORT):
            print(
                f"[slime] ERROR: 端口 {PORT} 仍被其他程序占用，slime server 无法启动。\n"
                f"  请手动结束占用进程（netstat -ano | findstr :{PORT}）或改用 SLIME_PORT 换端口。",
                file=sys.stderr,
            )
            sys.exit(1)

    # 2. 启动 Server
    print("[slime] 正在启动服务...")
    try:
        # A-080: server 用 CREATE_NEW_PROCESS_GROUP 脱离控制台信号组——
        # Ctrl+C（CTRL_C_EVENT）只发给前台进程组，若不隔离 server 会直接收到
        # SIGINT 退出（A-077 只修了 launcher 不清理，但 server 自己收到信号照样死）。
        # CLI 留在原组（它需要接收 Ctrl+C 做"保持会话"）；server 关闭仍由 _cleanup(taskkill) 负责。
        _creation_flags = 0
        if sys.platform == "win32":
            _creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        server_proc = subprocess.Popen(
            [sys.executable, str(SERVER_SCRIPT)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_creation_flags,
        )
    except Exception as e:
        print(f"[slime] 启动 Server 失败: {e}", file=sys.stderr)
        sys.exit(1)

    # 3. 等待 Server 就绪
    print("[slime] 等待服务就绪（首次启动 MCP 需下载依赖，最多 90 秒）...")
    if not _wait_server_ready():
        print("[slime] ERROR: 服务启动超时", file=sys.stderr)
        _cleanup()
        sys.exit(1)

    print(f"[slime] 服务已就绪 (http://127.0.0.1:{PORT})")

    # 4. 检测是否已完成首次配置
    #    未配置 → 自动跑 wizard(创建 Agent + Provider)
    #    已配置 → 直接进入交互模式
    if not _is_configured():
        print("[slime] 首次使用,进入配置向导...")
        print()
        try:
            subprocess.run(
                [sys.executable, str(CLI_SCRIPT), "wizard"],
                cwd=str(SLIME_DIR),
            )
        except KeyboardInterrupt:
            print()
        # wizard 结束后,如果仍未配置(用户中途退出),不继续进 CLI
        if not _is_configured():
            print("[slime] 配置未完成,请下次重新运行 slime 完成配置。")
            _cleanup()
            return
        print()
        print("[slime] 配置完成,进入交互模式(输入 /quit 退出)")
        print()
    else:
        print("[slime] 进入交互模式(输入 /quit 退出)")
        print()

    try:
        # 5. 运行 CLI (阻塞直到退出)
        # A-077: Ctrl+C 由 CLI 处理（保持会话不退出）——launcher 不得清理 server，
        # 否则 CLI 还在会话但服务已被杀（后续请求全部"无法连接"）。
        # 用 Popen+wait 循环：KeyboardInterrupt 时继续等待 CLI，直到其真正退出才清理。
        cli_proc = subprocess.Popen(
            [sys.executable, str(CLI_SCRIPT), *sys.argv[1:]],
            cwd=str(SLIME_DIR),
        )
        while True:
            try:
                ret = cli_proc.wait()
                break
            except KeyboardInterrupt:
                pass  # CLI 自己处理 Ctrl+C（保持会话），launcher 继续等待不清理
        sys.exit(ret)
    except KeyboardInterrupt:
        print()
    finally:
        # 6. 清理（仅在 CLI 真正退出后执行——Ctrl+C 不会走到这里）
        print()
        print("[slime] 正在关闭服务...")
        _cleanup()
        print("[slime] 已退出")


if __name__ == "__main__":
    main()
