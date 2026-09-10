/**
 * gui/src/main/httpServer.ts — HTTP 静态文件服务管理器（A-918++）。
 *
 * 把本地任意目录变成可被访问的 HTTP 静态服务：用于快速预览网页、局域网分享文件。
 * 仅依赖 Node 内置模块（node:http / node:fs / node:path / node:os），零新依赖。
 *
 * 特性：
 *  - serve：默认 host 0.0.0.0（局域网可访问），port 留空则自动从 8080 起找空闲端口；
 *  - 目录遍历防护（resolve 后必须仍在 dir 内，防 ../ 逃逸）；
 *  - 常见 MIME 类型（html/css/js/json/png/jpg/svg/woff2/...）；
 *  - index.html 默认页；可选 SPA fallback（未命中路径回 index.html，用于前端路由）；
 *  - 404/403 响应；每个 server 记访问计数；stop / stopAll / list 管理。
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { stat, createReadStream, type Stats } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { networkInterfaces } from "node:os";

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
}

/** serve 成功返回 */
export interface HttpServeResult {
  ok: boolean;
  id?: string;
  port?: number;
  host?: string;
  urls?: string[];
  error?: string;
}

interface ServerEntry {
  id: string;
  dir: string;
  host: string;
  port: number;
  server: Server;
  startedAt: number;
  requests: number;
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

/** 构造某端口的访问 URL 列表（本地回环 + 局域网） */
function buildUrls(port: number): string[] {
  const urls = [`http://127.0.0.1:${port}`];
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

    const host = params.host?.trim() || "0.0.0.0";
    const spa = Boolean(params.spa);

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
    const entry: ServerEntry = { id, dir, host, port, server: null as unknown as Server, startedAt, requests: 0 };

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
        resolvePromise({ ok: true, id, port, host, urls: buildUrls(port) });
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
      urls: buildUrls(e.port),
      startedAt: e.startedAt,
      requests: e.requests,
    }));
  }
}

/** 单例：主进程启动时创建，并通过 setHttpServer 注入 core-ts 工具层 */
export const httpServer = new HttpStaticServerManager();
