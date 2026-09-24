/**
 * gui/src/main/httpServer.ts — HTTP 静态文件服务管理器（A-918++）。
 *
 * 把本地任意目录变成可被访问的 HTTP 静态服务：用于快速预览网页、局域网分享文件。
 * 仅依赖 Node 内置模块（node:http / node:fs / node:path / node:os），零新依赖。
 *
 * 特性：
 *  - serve：**默认 host 127.0.0.1（仅本机可访问）**，显式传 0.0.0.0 才对外暴露到局域网；
 *    port 留空则自动从 8080 起找空闲端口；
 *  - 目录遍历防护（resolve 后必须仍在 dir 内，防 ../ 逃逸）；
 *  - 常见 MIME 类型（html/css/js/json/png/jpg/svg/woff2/...）；
 *  - index.html 默认页；可选 SPA fallback（未命中路径回 index.html，用于前端路由）；
 *  - 404/403 响应；每个 server 记访问计数；stop / stopAll / list 管理。
 *
 * 安全说明（A-918++ 加固）：早期实现默认监听 0.0.0.0，等于把本地目录直接暴露给同网段任何设备。
 * 现在默认回环，只有用户/模型显式要求局域网分享时才监听全部网卡，且调用前会走权限审批。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { stat, createReadStream, readFileSync, writeFileSync, mkdirSync, type Stats } from "node:fs";
import { extname, join, resolve, sep, dirname } from "node:path";
import { networkInterfaces } from "node:os";

/** 默认监听地址：仅本机回环（局域网分享需显式传 host: "0.0.0.0"） */
export const DEFAULT_HOST = "127.0.0.1";

/** 启动静态服务的入参 */
export interface HttpServeParams {
  /** 要对外提供服务的本地目录（绝对或相对路径） */
  dir: string;
  /** 监听端口；留空=自动从 8080 起选空闲端口 */
  port?: number;
  /** 监听地址；默认 0.0.0.0（局域网可访问） */
  host?: string;
  /** 是否开启 SPA fallback：未命中且非静态资源的路径回退到 index.html */
  spa?: boolean;
  /**
   * 这个服务是**谁起的**（#230 的范围判据）。
   *   · `agent`（缺省）= 本次应用运行期间由 Agent 的工具起的 → 属于「Agent 后台资源」面板；
   *   · `restored`    = 启动时由 `restore()` 按上一次运行的清单**重建**的
   *     —— 它是应用自己在启动阶段建的，不是"本次 Agent 运行途中打开的服务"。
   *     用户要求面板只显示「Agent 运行途中打开的工具、脚本、端口」，所以它**不进面板**。
   *     （A-977 的持久化目的——"重启后旧链接仍可用"——不受影响：服务照常运行、照常可访问。）
   */
  origin?: "agent" | "restored";
}

/** 运行中的服务信息（list 返回） */
export interface HttpServerInfo {
  /** 内部唯一 id（停止/查询用） */
  id: string;
  /** 服务目录 */
  dir: string;
  /** 实际监听端口 */
  port: number;
  /** 实际监听地址 */
  host: string;
  /** 可点击访问地址：含 127.0.0.1 与局域网 IP */
  urls: string[];
  /** 启动时间戳（ms） */
  startedAt: number;
  /** 累计请求数 */
  requests: number;
  /** #230：谁起的（`agent` = 本次 Agent 运行途中起的；`restored` = 启动时按上次清单重建的） */
  origin: "agent" | "restored";
}

/** serve 成功返回 */
export interface HttpServeResult {
  ok: boolean;
  id?: string;
  port?: number;
  host?: string;
  urls?: string[];
  error?: string;
  /** A-975：是否复用了同目录既有服务（true 时未新开端口） */
  reused?: boolean;
}

interface ServerEntry {
  id: string;
  dir: string;
  host: string;
  port: number;
  server: Server;
  startedAt: number;
  requests: number;
  /** A-977：SPA 回退开关（持久化时需一并记录） */
  spa?: boolean;
  /** #230：谁起的（见 HttpServeParams.origin） */
  origin: "agent" | "restored";
}

/** 常见 MIME 类型映射（扩展名小写 → Content-Type） */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

/** 取本机非内部 IPv4 地址（用于拼局域网访问 URL） */
function lanIPv4(): string[] {
  const nets = networkInterfaces();
  const out: string[] = [];
  for (const list of Object.values(nets)) {
    if (!list) { continue; }
    for (const ni of list) {
      // 仅 IPv4 且非内部地址（回环 127.* 与 169.254 链路本地跳过）
      if (ni.family === "IPv4" && !ni.internal) {
        out.push(ni.address);
      }
    }
  }
  return out;
}

/** 构造某端口的访问 URL 列表：回环恒定给出；仅当显式监听非回环地址时才附局域网 IP */
function buildUrls(port: number, host: string = DEFAULT_HOST): string[] {
  const urls = [`http://127.0.0.1:${port}`];
  const loopbackOnly = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (loopbackOnly) { return urls; }
  if (host && host !== "0.0.0.0" && host !== "::") {
    urls.push(`http://${host}:${port}`);
    return urls;
  }
  for (const ip of lanIPv4()) {
    urls.push(`http://${ip}:${port}`);
  }
  return urls;
}

/** 探测端口是否空闲（临时起一个服务监听后立刻关闭） */
function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    const onErr = (): void => { probe.removeListener("error", onErr); resolve(false); };
    probe.once("error", onErr);
    probe.listen(port, host, () => {
      probe.removeListener("error", onErr);
      probe.close(() => resolve(true));
    });
  });
}

/** 自动选端口：从 start 起递增，最多尝试 100 个 */
async function pickFreePort(start: number, host: string): Promise<number | null> {
  for (let p = start; p < start + 100; p++) {
    if (await isPortFree(p, host)) { return p; }
  }
  return null;
}

/** 发送文件内容（带 Content-Type 与长度） */
function sendFile(res: ServerResponse, filePath: string, st: Stats): void {
  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": st.size,
    "Cache-Control": "no-cache",
  });
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("500 Internal Server Error");
  });
  stream.pipe(res);
}

/** 回退到 index.html（SPA 场景）：文件不存在则 404 */
function sendIndexOr404(res: ServerResponse, dir: string): void {
  const indexPath = join(dir, "index.html");
  stat(indexPath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }
    sendFile(res, indexPath, st);
  });
}

/**
 * HTTP 静态服务管理器（单例）。
 * 用方：gui/src/main/index.ts 在启动时实例化并注入 core-ts 工具层。
 */
class HttpStaticServerManager {
  private entries = new Map<string, ServerEntry>();
  private seq = 0;
  /**
   * A-977：服务清单持久化路径（由装配层注入）。
   * 此前服务表只在内存 Map 里、退出即 stopAll → 重启后旧链接全部失效（用户实测痛点）。
   * 现在每次 serve/stop 落盘，启动时 restore() 按记录的端口重建服务。
   */
  private persistPath: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  setPersistPath(p: string | null): void {
    this.persistPath = p;
  }

  /** 落盘（去抖 300ms，避免频繁写盘） */
  private schedulePersist(): void {
    if (!this.persistPath) { return; }
    if (this.persistTimer) { clearTimeout(this.persistTimer); }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        const list = [...this.entries.values()].map((e) => ({ dir: e.dir, host: e.host, port: e.port, spa: Boolean((e as { spa?: boolean }).spa) }));
        mkdirSync(dirname(this.persistPath as string), { recursive: true });
        writeFileSync(this.persistPath as string, JSON.stringify({ version: 1, entries: list }, null, 2), "utf8");
      } catch { /* 落盘失败不影响服务运行 */ }
    }, 300);
  }

  /**
   * A-977：启动时按持久化清单重建静态服务。
   * 先按记录端口尝试（链接尽量不变）；端口被占则自动改选空闲端口（并回写新端口）。
   */
  async restore(): Promise<{ restored: number; failed: number }> {
    if (!this.persistPath) { return { restored: 0, failed: 0 }; }
    let list: Array<{ dir?: string; host?: string; port?: number; spa?: boolean }> = [];
    try {
      const raw = readFileSync(this.persistPath, "utf8");
      const parsed = JSON.parse(raw) as { entries?: typeof list };
      list = Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch { return { restored: 0, failed: 0 }; }
    let restored = 0; let failed = 0;
    for (const e of list) {
      const dir = (e.dir ?? "").trim();
      if (!dir) { continue; }
      const host = (e.host ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
      const port = Number.isFinite(e.port) ? Number(e.port) : 0;
      // #230：标记为「启动时重建」——它不进「Agent 后台资源」面板（用户只想要运行途中打开的）
      let r = await this.serve({ dir, host, port, spa: Boolean(e.spa), origin: "restored" });
      if (!r.ok && port > 0) {
        // 端口被占 → 改选空闲端口（链接会变，但服务可用）
        r = await this.serve({ dir, host, port: 0, spa: Boolean(e.spa), origin: "restored" });
      }
      if (r.ok) { restored++; this.schedulePersist(); } else { failed++; }
    }
    return { restored, failed };
  }

  /** 启动一个静态文件服务 */
  async serve(params: HttpServeParams): Promise<HttpServeResult> {
    const dir = resolve(params.dir ?? "");
    if (!dir) { return { ok: false, error: "dir 不能为空" }; }

    // 校验目录存在且为目录
    let dirStat: Stats | null = null;
    try {
      dirStat = await new Promise<Stats>((resolveStat, reject) => stat(dir, (e, s) => (e ? reject(e) : resolveStat(s))));
    } catch {
      return { ok: false, error: `目录不存在：${dir}` };
    }
    if (!dirStat.isDirectory()) {
      return { ok: false, error: `不是目录：${dir}` };
    }

    const host = params.host?.trim() || DEFAULT_HOST;
    const spa = Boolean(params.spa);

    // A-975：**同目录复用**——同一目录已起过服务则直接返回既有地址，
    // 避免"每次生成都新开端口"导致链接漂移、进程里堆一堆服务（也保证重启后链接尽量稳定）。
    for (const e of this.entries.values()) {
      if (resolve(e.dir) === dir && e.host === host) {
        /* #230：复用发生在**本次运行**里的 Agent 调用中 → 这个服务从这一刻起就是
           "Agent 运行途中打开的服务"，把 restored 标记**升格**为 agent，
           否则会出现"Agent 明明刚起过它、面板里却看不到"的反向错位。 */
        if (e.origin === "restored") {
          e.origin = "agent";
          e.startedAt = Date.now(); // 时长从"本次被 Agent 起用"算起，不把上次运行的时长算进去
          this.schedulePersist();
        }
        return { ok: true, id: e.id, port: e.port, host: e.host, urls: buildUrls(e.port, e.host), reused: true } as HttpServeResult;
      }
    }

    // 端口：指定则校验空闲，否则自动选
    let port = params.port && Number.isFinite(params.port) ? Number(params.port) : 0;
    if (port > 0) {
      if (!(await isPortFree(port, host))) {
        return { ok: false, error: `端口 ${port} 已被占用（${host}）` };
      }
    } else {
      const picked = await pickFreePort(8080, host);
      if (picked == null) {
        return { ok: false, error: "无法找到空闲端口（8080 起尝试 100 个均失败）" };
      }
      port = picked;
    }

    const rootResolved = resolve(dir);

    // 先建 entry（server 稍后回填），handler 通过闭包累加请求计数
    const id = `http_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    const startedAt = Date.now();
    const entry: ServerEntry = {
      id, dir, host, port, server: null as unknown as Server, startedAt, requests: 0, spa,
      // #230：缺省即"Agent 起的"（`restore()` 会显式传 restored）
      origin: params.origin === "restored" ? "restored" : "agent",
    };

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      // 计数：每进入一次请求 +1
      entry.requests++;

      try {
        const reqUrl = new URL(req.url ?? "/", "http://localhost");
        let pathname = decodeURIComponent(reqUrl.pathname);
        if (pathname.length === 0 || pathname === "/") { pathname = "/index.html"; }
        else if (pathname.endsWith("/")) { pathname += "index.html"; }

        // 目录遍历防护：resolve 后必须仍在 dir 内（防 ../ 逃逸）
        const target = join(dir, pathname);
        const resolved = resolve(target);
        const isInside = resolved === rootResolved || resolved.startsWith(rootResolved + sep);
        if (!isInside) {
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("403 Forbidden");
          return;
        }

        stat(resolved, (err, st) => {
          if (err || !st.isFile()) {
            // 未命中：SPA 模式回退 index.html；否则 404
            if (spa && !extname(pathname)) {
              sendIndexOr404(res, dir);
            } else {
              res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
              res.end("404 Not Found");
            }
            return;
          }
          sendFile(res, resolved, st);
        });
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end(`500 Internal Server Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    const server = createServer(handler);
    entry.server = server;
    this.entries.set(id, entry);

    return new Promise<HttpServeResult>((resolvePromise) => {
      const onListenErr = (e: Error): void => {
        this.entries.delete(id);
        resolvePromise({ ok: false, error: `监听失败：${e.message}` });
      };
      server.once("error", onListenErr);
      server.listen(port, host, () => {
        server.removeListener("error", onListenErr);
        this.schedulePersist(); // A-977：服务起来即落盘（供重启后恢复）
        resolvePromise({ ok: true, id, port, host, urls: buildUrls(port, host) });
      });
    });
  }

  /** 停止指定服务 */
  async stop(id: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.entries.get(id);
    if (!entry) { return { ok: false, error: `未找到服务：${id}` }; }
    try {
      entry.server.close();
    } catch { /* 忽略关闭异常 */ }
    this.entries.delete(id);
    this.schedulePersist(); // A-977：显式停止要落盘（下次启动不再恢复它）
    return { ok: true };
  }

  /** 停止全部服务 */
  stopAll(): { ok: boolean; stopped: number } {
    let stopped = 0;
    for (const entry of this.entries.values()) {
      try { entry.server.close(); } catch { /* 忽略 */ }
      stopped++;
    }
    this.entries.clear();
    return { ok: true, stopped };
  }

  /** 列出运行中的服务 */
  async list(): Promise<HttpServerInfo[]> {
    return Array.from(this.entries.values()).map((e) => ({
      id: e.id,
      dir: e.dir,
      port: e.port,
      host: e.host,
      urls: buildUrls(e.port, e.host),
      startedAt: e.startedAt,
      requests: e.requests,
      origin: e.origin,
    }));
  }
}

/** 单例：主进程启动时创建，并通过 setHttpServer 注入 core-ts 工具层 */
export const httpServer = new HttpStaticServerManager();
