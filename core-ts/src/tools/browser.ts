/**
 * core-ts/src/tools/browser.ts — 右侧栏浏览器控制工具（A-976）。
 *
 * 与 screen_*（ADB/桌面）的设计对齐：**元素优先于坐标**。
 * 推荐流程：browser_navigate 打开网址 → browser_snapshot 拿元素（带序号/文本/选择器）
 *          → browser_click({text|selector|index}) → browser_screenshot 核对。
 *
 * 依赖注入：主进程装配层用 setBrowserAdapter 注入 BrowserBridge（core-ts 不依赖 Electron）。
 */
import { Tool, type ToolRegistry } from "./registry.js";

/** 浏览器指令执行器（由 GUI 主进程注入） */
export interface BrowserLike {
  exec(cmd: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

let browserRef: BrowserLike | null = null;

export function setBrowserAdapter(b: BrowserLike | null): void {
  browserRef = b;
}

function needBrowser(): BrowserLike | null {
  return browserRef;
}

const NO_BROWSER = "[错误] 浏览器控制未就绪（右侧栏浏览器不可用；请确认应用已装配 BrowserBridge 且右侧栏可用）";

function pickTabId(args: Record<string, unknown>): string | undefined {
  const v = args.tabId;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

async function call(cmd: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const b = needBrowser();
  if (!b) { return { ok: false, error: NO_BROWSER }; }
  return b.exec(cmd, timeoutMs);
}

/** 把任意结构安全转成可读文本 */
function pretty(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function registerBrowserTools(registry: ToolRegistry): void {
  /* ── 浏览标签管理 ── */

  registry.register(new Tool({
    name: "browser_tabs",
    description: "列出右侧边栏当前打开的所有浏览器页（tabId / 标题 / 网址 / 是否激活）。browser_* 系列工具默认操作**当前激活的浏览器页**；要操作其他页可传对应 tabId。",
    parameters: { type: "object", properties: {}, required: [] },
    executeFn: async () => {
      const r = await call({ kind: "tabs" });
      if (!r.ok) { return `[错误] ${r.error}`; }
      const tabs = Array.isArray(r.data) ? r.data as Array<{ id: string; title: string; url: string; active: boolean }> : [];
      if (tabs.length === 0) { return "[浏览器] 当前没有打开的浏览器页（可 browser_navigate 打开一个网址）"; }
      return ["[浏览器页]", ...tabs.map((t) => `- ${t.active ? "▶ " : "  "}${t.url || "(空白)"}｜${t.title}｜tabId=${t.id}`)].join("\n");
    },
    permissions: ["read"],
    riskKind: "read",
    autoApprovable: true,
  }));

  registry.register(new Tool({
    name: "browser_open_tab",
    description: "在右侧边栏**新开一个浏览器页**（可选带网址），并激活它。用于同时浏览多个网站。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "可选。要打开的网址" },
        activate: { type: "boolean", description: "是否切到该页（默认 true）" },
      },
      required: [],
    },
    executeFn: async (args) => {
      const r = await call({ kind: "open", url: typeof args.url === "string" ? args.url : undefined, activate: args.activate !== false });
      if (!r.ok) { return `[错误] ${r.error}`; }
      const d = r.data as { tabId?: string; systemOpened?: boolean; url?: string; handler?: string } | undefined;
      if (d?.systemOpened) {
        return `[已交给系统打开] ${d.url}${d.handler ? `（${d.handler}）` : ""}——此类链接由本机客户端处理，不新开浏览器页；链接目的已达成。`;
      }
      return `[已新开浏览器页] tabId=${d?.tabId ?? "?"}`;
    },
    permissions: ["write"],
    riskKind: "write",
  }));

  registry.register(new Tool({
    name: "browser_close_tab",
    description: "关闭右侧边栏的浏览器页（缺省关闭当前激活页）。",
    parameters: { type: "object", properties: { tabId: { type: "string", description: "可选。要关闭的页 id" } }, required: [] },
    executeFn: async (args) => {
      const r = await call({ kind: "close", tabId: pickTabId(args) });
      if (!r.ok) { return `[错误] ${r.error}`; }
      const d = r.data as { closed?: boolean } | undefined;
      return d?.closed ? "[已关闭浏览器页]" : "[未能关闭]（可能不存在或是常驻页）";
    },
    permissions: ["write"],
    riskKind: "write",
  }));

  /* ── 导航 / 读取 ── */

  registry.register(new Tool({
    name: "browser_navigate",
    description: [
      "在右侧边栏浏览器中打开网址（没有浏览器页会自动新建）。会等待页面加载完成。之后用 browser_snapshot 看页面元素。",
      "非 http(s) 链接（bitbrowser:// 等）：返回结果会说明「已交给系统打开」或「需安装对应客户端」，不在浏览器页承载。",
      "打开后若弹出登录/验证弹窗：先尝试关闭右上角×；关不掉或反复弹出 → 如实告知用户该页面要求登录（不要反复空转）。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要打开的网址（可省略协议，自动补 https://）" },
        tabId: { type: "string", description: "可选。指定浏览器页 id（缺省用当前激活页）" },
      },
      required: ["url"],
    },
    executeFn: async (args) => {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) { return "[错误] 需要 url"; }
      const r = await call({ kind: "navigate", url, tabId: pickTabId(args) }, 45_000);
      if (!r.ok) { return `[错误] ${r.error}`; }
      const d = r.data as { url?: string; systemOpened?: boolean; handler?: string; popupNotice?: string } | undefined;
      // A-980-R2：系统协议链接（bitbrowser:// 等）——交给系统应用真实打开，不在浏览器页承载
      if (d?.systemOpened) {
        return `[已交给系统打开] ${d.url}${d.handler ? `（${d.handler}）` : ""}——此类链接由本机客户端处理，右侧栏浏览器不打开；链接目的已达成。`;
      }
      const lines: string[] = [`[已打开] ${d?.url ?? url}`];
      if (d?.popupNotice) { lines.push(`⚠️ ${d.popupNotice}`); }
      // A-980：「导航即观察」——navigate 返回时顺带取首屏可操作元素清单（业界共识：fba / agent-browser 的
      // "快照即观察"，Anthropic Computer Use GA 批量动作同思路）。
      // 模型打开页面后**不需要再单独调 browser_snapshot 看页面有什么**，直接按清单 click，省 1-2 轮模型往返
      // （每轮 = 1-3s prefill+decode，这正是"操控墨迹半天"的主要来源）。
      const snap = await call({ kind: "snapshot", tabId: pickTabId(args) }, 10_000);
      if (snap.ok) {
        const s = snap.data as { elements?: Array<{ index: number; tag: string; text: string; selector: string }> } | undefined;
        const els = s?.elements ?? [];
        if (els.length > 0) {
          lines.push(`首屏可操作元素（${els.length} 个，可直接 browser_click({index:N})）：`);
          for (const e of els.slice(0, 30)) {
            lines.push(`#${e.index} <${e.tag}>${e.text ? ` "${e.text}"` : ""}  ${e.selector}`);
          }
          if (els.length > 30) { lines.push(`…（共 ${els.length} 个）`); }
        } else {
          lines.push("首屏无可操作元素——可 browser_scroll 下滑或 browser_wait 后再看。");
        }
      }
      lines.push("提示：目标元素不在清单中时再 browser_scroll / browser_snapshot。");
      return lines.join("\n");
    },
    permissions: ["network", "write"],
    riskKind: "network",
  }));

  registry.register(new Tool({
    name: "browser_read",
    description: "读取右侧边栏浏览器当前页面的内容（url / 标题 / 正文文本；mode=html 时取 HTML 片段）。用于理解页面、提取信息。",
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", description: "text（默认，取正文文本）或 html" },
        tabId: { type: "string", description: "可选。浏览器页 id" },
      },
      required: [],
    },
    executeFn: async (args) => {
      const r = await call({ kind: "read", mode: args.mode === "html" ? "html" : "text", tabId: pickTabId(args) });
      if (!r.ok) { return `[错误] ${r.error}`; }
      const d = r.data as { url?: string; title?: string; text?: string; html?: string } | undefined;
      const body = d?.text ?? d?.html ?? "";
      return [`[页面] ${d?.title ?? ""}｜${d?.url ?? ""}`, "---", body].join("\n");
    },
    permissions: ["read"],
    riskKind: "read",
    autoApprovable: true,
  }));

  /* ── 元素快照（最稳的定位方式） ── */

  registry.register(new Tool({
    name: "browser_snapshot",
    description: [
      "导出当前网页的**可操作元素清单**（编号 / 标签 / 文本 / CSS 选择器 / 坐标）+ 输入框清单。",
      "**这是浏览器操作里最可靠的方式**：拿到元素后用 browser_click（传 selector 或 text 或 index）点击，",
      "用 browser_type（传 selector）填表——比凭坐标点击稳得多。",
      "元素不含目标时：先 browser_scroll 下滑再 snapshot；单页应用可 browser_wait 后再 snapshot。",
    ].join("\n"),
    parameters: { type: "object", properties: { tabId: { type: "string", description: "可选。浏览器页 id" } }, required: [] },
    executeFn: async (args) => {
      const r = await call({ kind: "snapshot", tabId: pickTabId(args) });
      if (!r.ok) { return `[错误] ${r.error}`; }
      const d = r.data as { url?: string; title?: string; elements?: Array<{ index: number; tag: string; text: string; selector: string }>; inputs?: Array<{ selector: string; placeholder: string; value: string }>; popupNotice?: string } | undefined;
      const lines: string[] = [`[页面] ${d?.title ?? ""}｜${d?.url ?? ""}`, `可操作元素（${d?.elements?.length ?? 0} 个）：`];
      if (d?.popupNotice) { lines.push(`⚠️ ${d.popupNotice}`); }
      for (const e of (d?.elements ?? []).slice(0, 60)) {
        lines.push(`#${e.index} <${e.tag}>${e.text ? ` "${e.text}"` : ""}  selector=${e.selector}`);
      }
      if ((d?.inputs ?? []).length > 0) {
        lines.push("输入框：");
        for (const i of d?.inputs ?? []) { lines.push(`  - ${i.selector} ${i.placeholder ? `placeholder="${i.placeholder}"` : ""} ${i.value ? `当前值="${i.value}"` : ""}`); }
      }
      lines.push("用法：browser_click({index:N}) 或 browser_click({text:\"登录\"}) 或 browser_click({selector:\"#submit\"})；browser_type({text:\"xxx\", selector:\"...\"})");
      lines.push("滑块/拖拽类交互（canvas 验证码、拖拽排序等）用 browser_drag（from_x/from_y → to_x/to_y 坐标，配合 browser_screenshot 定位）。");
      return lines.join("\n");
    },
    permissions: ["read"],
    riskKind: "read",
    autoApprovable: true,
  }));

  /* ── 交互 ── */

  registry.register(new Tool({
    name: "browser_click",
    description: [
      "在右侧边栏浏览器里点击元素。优先用 selector / text / index（来自 browser_snapshot），也支持坐标 x,y。",
      "**点击结果会自动附带点击后的画面观察**（主要元素清单，A-980 点击即观察）——一般**无需**再单独调 browser_snapshot 核对；",
      "可连续操作（如点击 → 输入 → 回车）一气完成，观察提示足够就直接进入下一步。",
      "**登录/会员弹窗策略**：页面弹出登录弹窗时，先找右上角关闭按钮（通常 aria-label=关闭/×）点击关闭；",
      "关闭后操作仍被弹窗拦截或弹窗再次出现 → **立即停止并如实告知用户该页面要求登录**，不要反复点击/快照空转。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 选择器（推荐，来自 browser_snapshot）" },
        text: { type: "string", description: "元素可见文本（包含匹配）" },
        index: { type: "integer", description: "browser_snapshot 里的编号（1 起）" },
        x: { type: "number", description: "可选。坐标 x（页面像素）" },
        y: { type: "number", description: "可选。坐标 y" },
        tabId: { type: "string", description: "可选。浏览器页 id" },
      },
      required: [],
    },
    executeFn: async (args) => {
      const r = await call({ kind: "click", selector: args.selector, text: args.text, index: typeof args.index === "number" ? args.index : undefined, x: args.x, y: args.y, tabId: pickTabId(args) });
      if (!r.ok) { return `[错误] ${r.error}`; }
      const d = r.data as { clicked?: string; observe?: string; popupNotice?: string } | undefined;
      const lines = [`[已点击] ${d?.clicked ?? "元素"}`];
      if (d?.popupNotice) { lines.push(`⚠️ ${d.popupNotice}`); }
      if (d?.observe) { lines.push(`点击后画面：${d.observe}`); }
      lines.push("提示：观察不足或需要视觉核对时再用 browser_screenshot。");
      return lines.join("\n");
    },
    permissions: ["write"],
    riskKind: "write",
  }));

  registry.register(new Tool({
    name: "browser_type",
    description: [
      "在右侧边栏浏览器的输入框里填文本（自动 focus；可用 selector 指定输入框，缺省取当前聚焦或第一个输入框）。submit=true 时随后回车提交。",
      "**结果会自动附带输入/提交后的画面观察**——不需每次再 browser_snapshot；输入后要提交时直接 submit=true 一步完成。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要输入的文本" },
        selector: { type: "string", description: "可选。目标输入框的 CSS 选择器" },
        submit: { type: "boolean", description: "输入后是否回车提交（默认 false）" },
        tabId: { type: "string", description: "可选。浏览器页 id" },
      },
      required: ["text"],
    },
    executeFn: async (args) => {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) { return "[错误] 需要 text"; }
      const r = await call({ kind: "type", text, selector: args.selector, submit: args.submit === true, tabId: pickTabId(args) }, 30_000);
      if (!r.ok) { return `[错误] ${r.error}`; }
      const d = r.data as { submitted?: boolean; observe?: string } | undefined;
      const lines = [`[已输入] ${text.slice(0, 40)}${d?.submitted ? "（已回车提交）" : ""}`];
      if (d?.observe) { lines.push(`输入后画面：${d.observe}`); }
      return lines.join("\n");
    },
    permissions: ["write"],
    riskKind: "write",
  }));

  registry.register(new Tool({
    name: "browser_press",
    description: "在右侧边栏浏览器里按键（如 Enter / Escape / Tab / ArrowDown / Backspace）。Enter 提交、方向健选择等场景结果会附带画面观察。",
    parameters: {
      type: "object",
      properties: { key: { type: "string", description: "按键名" }, tabId: { type: "string", description: "可选。浏览器页 id" } },
      required: ["key"],
    },
    executeFn: async (args) => {
      const key = typeof args.key === "string" ? args.key : "";
      if (!key) { return "[错误] 需要 key"; }
      const r = await call({ kind: "press", key, tabId: pickTabId(args) });
      if (!r.ok) { return `[错误] ${r.error}`; }
      const d = r.data as { observe?: string } | undefined;
      const lines = [`[已按键] ${key}`];
      if (d?.observe) { lines.push(`按键后画面：${d.observe}`); }
      return lines.join("\n");
    },
    permissions: ["write"],
    riskKind: "write",
  }));

  registry.register(new Tool({
    name: "browser_scroll",
    description: "在右侧边栏浏览器里滚动页面（delta 正数向下、负数向上，单位像素；默认 600）。用于加载更多内容或把目标滚入视野。`结果会附带滚动后可见的主要元素观察`（懒加载页面滚完即出新内容，无需再 snapshot）。",
    parameters: {
      type: "object",
      properties: {
        delta: { type: "number", description: "滚动像素：正=向下，负=向上" },
        tabId: { type: "string", description: "可选。浏览器页 id" },
      },
      required: [],
    },
    executeFn: async (args) => {
      const r = await call({ kind: "scroll", delta: typeof args.delta === "number" ? args.delta : 600, tabId: pickTabId(args) });
      if (!r.ok) { return `[错误] ${r.error}`; }
      const d = r.data as { scrolled?: number; observe?: string } | undefined;
      const lines = [`[已滚动] ${JSON.stringify({ scrolled: d?.scrolled })}`];
      if (d?.observe) { lines.push(`滚动后画面：${d.observe}`); }
      return lines.join("\n");
    },
    permissions: ["write"],
    riskKind: "write",
  }));

  registry.register(new Tool({
    name: "browser_drag",
    description: [
      "在右侧边栏浏览器里执行**鼠标拖拽**（按住起点 → 平滑拖动 → 终点松开）。",
      "适用：滑块拼图验证码、拖拽排序、画布/图表拖动、范围框选等需要「按住拖动」的交互（browser_click 做不到）。",
      "起点与终点都支持两种定位：",
      "  ① **坐标**：from_x/from_y → to_x/to_y（页面像素，与 browser_snapshot / browser_screenshot 的编号框同基准）。",
      "     **canvas 渲染的滑块验证码没有 DOM 元素，必须用坐标**——先 browser_screenshot 看图，判断滑块当前位置与目标缺口位置，取两点坐标传入。",
      "  ② **元素**：from_selector/from_text/from_index → to_selector/to_text/to_index（来自 browser_snapshot，自动取元素中心点）。",
      "高精度参数：duration_ms 拖拽总时长毫秒（默认 800，滑块类建议 500-1200）；steps 中间移动步数（默认 20，越大轨迹越平滑）；jitter=false 可关闭轨迹微抖（默认开启，模拟人手抖动、规避风控机械直线特征）。",
      "注意：iframe 内元素用坐标拖拽即可（原生输入事件直达页面），元素定位仅查顶层文档。跨屏长距离拖拽建议用坐标定位（元素定位的 scrollIntoView 会滚动页面、使另一端点坐标偏移）。拖拽后会自动回传画面观察。",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        from_x: { type: "number", description: "起点坐标 x（页面像素；canvas 滑块场景用截图定位）" },
        from_y: { type: "number", description: "起点坐标 y" },
        from_selector: { type: "string", description: "起点元素 CSS 选择器（与坐标二选一）" },
        from_text: { type: "string", description: "起点元素可见文本（包含匹配）" },
        from_index: { type: "integer", description: "起点 browser_snapshot 编号（1 起）" },
        to_x: { type: "number", description: "终点坐标 x" },
        to_y: { type: "number", description: "终点坐标 y" },
        to_selector: { type: "string", description: "终点元素 CSS 选择器（与坐标二选一）" },
        to_text: { type: "string", description: "终点元素可见文本" },
        to_index: { type: "integer", description: "终点 browser_snapshot 编号" },
        duration_ms: { type: "integer", description: "拖拽总时长毫秒（默认 800，范围 100-8000）" },
        steps: { type: "integer", description: "中间移动步数（默认 20，范围 2-80）" },
        jitter: { type: "boolean", description: "是否开启轨迹微抖动（默认 true）" },
        tabId: { type: "string", description: "可选。浏览器页 id" },
      },
      required: [],
    },
    executeFn: async (args) => {
      const r = await call({
        kind: "drag",
        from_x: args.from_x, from_y: args.from_y,
        from_selector: args.from_selector, from_text: args.from_text, from_index: typeof args.from_index === "number" ? args.from_index : undefined,
        to_x: args.to_x, to_y: args.to_y,
        to_selector: args.to_selector, to_text: args.to_text, to_index: typeof args.to_index === "number" ? args.to_index : undefined,
        duration_ms: typeof args.duration_ms === "number" ? args.duration_ms : undefined,
        steps: typeof args.steps === "number" ? args.steps : undefined,
        jitter: typeof args.jitter === "boolean" ? args.jitter : undefined,
        tabId: pickTabId(args),
      }, 30_000);
      if (!r.ok) { return `[错误] ${r.error}`; }
      const d = r.data as { dragged?: string; from?: { x: number; y: number }; to?: { x: number; y: number }; observe?: string } | undefined;
      const span = d?.from && d?.to ? `（${d.from.x},${d.from.y} → ${d.to.x},${d.to.y}）` : "";
      const lines = [`[已拖拽] ${d?.dragged ?? "..."}${span}`];
      if (d?.observe) { lines.push(`拖拽后画面：${d.observe}`); }
      lines.push("提示：滑块是否到位若不明确（如验证码），再用 browser_screenshot 视觉核对。");
      return lines.join("\n");
    },
    permissions: ["write"],
    riskKind: "write",
  }));

  /* ── 截图 / 等待 ── */

  registry.register(new Tool({
    name: "browser_screenshot",
    description: "截取右侧边栏浏览器当前页面并把画面回传给你（默认叠加可点元素编号框，Set-of-Mark）。用于视觉核对页面状态、定位视觉元素。",
    parameters: {
      type: "object",
      properties: {
        marks: { type: "boolean", description: "是否叠加元素编号框（默认 true）" },
        tabId: { type: "string", description: "可选。浏览器页 id" },
      },
      required: [],
    },
    executeFn: async (args) => {
      const r = await call({ kind: "screenshot", marks: args.marks !== false, tabId: pickTabId(args) }, 30_000);
      if (!r.ok) { return `[错误] ${r.error}`; }
      const d = r.data as { dataUrl?: string; marks?: number } | undefined;
      if (!d?.dataUrl) { return "[错误] 截图为空"; }
      const parts = [`[网页截图] 已叠加 ${d.marks ?? 0} 个元素编号框（可直接用 browser_click({index:N}) 点）`];
      parts.push(`@@IMG@@${d.dataUrl}`);
      return parts.join("\n");
    },
    permissions: ["read"],
    riskKind: "read",
    autoApprovable: true,
  }));

  registry.register(new Tool({
    name: "browser_wait",
    description: "等待一段时间（毫秒，最多 15000），给页面加载/动画/异步渲染留时间。",
    parameters: { type: "object", properties: { durationMs: { type: "integer", description: "等待毫秒数（默认 1000）" } }, required: [] },
    executeFn: async (args) => {
      const ms = typeof args.durationMs === "number" ? args.durationMs : 1000;
      const r = await call({ kind: "wait", durationMs: ms }, ms + 5000);
      if (!r.ok) { return `[错误] ${r.error}`; }
      return `[已等待] ${pretty(r.data)}`;
    },
    permissions: ["read"],
    riskKind: "read",
    autoApprovable: true,
  }));
}
