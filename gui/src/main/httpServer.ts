
















import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { stat, createReadStream, readFileSync, writeFileSync, mkdirSync, type Stats } from "node:fs";
import { extname, join, resolve, sep, dirname } from "node:path";
import { networkInterfaces } from "node:os";


export const DEFAULT_HOST = "127.0.0.1";


export interface HttpServeParams {
  
  dir: string;
  
  port?: number;
  
  host?: string;
  
  spa?: boolean;
  
















  origin?: "agent" | "restored" | "builtin";
}


export interface HttpServerInfo {
  
  id: string;
  
  dir: string;
  
  port: number;
  
  host: string;
  
  urls: string[];
  
  startedAt: number;
  
  requests: number;
  
  origin: "agent" | "restored" | "builtin";
}


export interface HttpServeResult {
  ok: boolean;
  id?: string;
  port?: number;
  host?: string;
  urls?: string[];
  error?: string;
  
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
  
  spa?: boolean;
  
  origin: "agent" | "restored" | "builtin";
}


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


function lanIPv4(): string[] {
  const nets = networkInterfaces();
  const out: string[] = [];
  for (const list of Object.values(nets)) {
    if (!list) { continue; }
    for (const ni of list) {
      
      if (ni.family === "IPv4" && !ni.internal) {
        out.push(ni.address);
      }
    }
  }
  return out;
}


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


async function pickFreePort(start: number, host: string): Promise<number | null> {
  for (let p = start; p < start + 100; p++) {
    if (await isPortFree(p, host)) { return p; }
  }
  return null;
}


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





class HttpStaticServerManager {
  private entries = new Map<string, ServerEntry>();
  private seq = 0;
  




  private persistPath: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  setPersistPath(p: string | null): void {
    this.persistPath = p;
  }

  
  private schedulePersist(): void {
    if (!this.persistPath) { return; }
    if (this.persistTimer) { clearTimeout(this.persistTimer); }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        


        const list = [...this.entries.values()]
          .filter((e) => e.origin !== "builtin")
          .map((e) => ({ dir: e.dir, host: e.host, port: e.port, spa: Boolean((e as { spa?: boolean }).spa) }));
        mkdirSync(dirname(this.persistPath as string), { recursive: true });
        writeFileSync(this.persistPath as string, JSON.stringify({ version: 1, entries: list }, null, 2), "utf8");
      } catch {  }
    }, 300);
  }

  



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
      
      let r = await this.serve({ dir, host, port, spa: Boolean(e.spa), origin: "restored" });
      if (!r.ok && port > 0) {
        
        r = await this.serve({ dir, host, port: 0, spa: Boolean(e.spa), origin: "restored" });
      }
      if (r.ok) { restored++; this.schedulePersist(); } else { failed++; }
    }
    return { restored, failed };
  }

  
  async serve(params: HttpServeParams): Promise<HttpServeResult> {
    const dir = resolve(params.dir ?? "");
    if (!dir) { return { ok: false, error: "dir 不能为空" }; }

    
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

    
    
    for (const e of this.entries.values()) {
      if (resolve(e.dir) === dir && e.host === host) {
        




        if (e.origin === "restored") {
          e.origin = "agent";
          e.startedAt = Date.now(); 
          this.schedulePersist();
        }
        return { ok: true, id: e.id, port: e.port, host: e.host, urls: buildUrls(e.port, e.host), reused: true } as HttpServeResult;
      }
    }

    
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

    
    const id = `http_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    const startedAt = Date.now();
    const entry: ServerEntry = {
      id, dir, host, port, server: null as unknown as Server, startedAt, requests: 0, spa,
      
      origin: params.origin === "restored" ? "restored" : params.origin === "builtin" ? "builtin" : "agent",
    };

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      
      entry.requests++;

      try {
        const reqUrl = new URL(req.url ?? "/", "http://localhost");
        let pathname = decodeURIComponent(reqUrl.pathname);
        if (pathname.length === 0 || pathname === "/") { pathname = "/index.html"; }
        else if (pathname.endsWith("/")) { pathname += "index.html"; }

        
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
        this.schedulePersist(); 
        resolvePromise({ ok: true, id, port, host, urls: buildUrls(port, host) });
      });
    });
  }

  
  async stop(id: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.entries.get(id);
    if (!entry) { return { ok: false, error: `未找到服务：${id}` }; }
    try {
      entry.server.close();
    } catch {  }
    this.entries.delete(id);
    this.schedulePersist(); 
    return { ok: true };
  }

  
  stopAll(): { ok: boolean; stopped: number } {
    let stopped = 0;
    for (const entry of this.entries.values()) {
      try { entry.server.close(); } catch {  }
      stopped++;
    }
    this.entries.clear();
    return { ok: true, stopped };
  }

  
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


export const httpServer = new HttpStaticServerManager();
