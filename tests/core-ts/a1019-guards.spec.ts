/**
 * tests/core-ts/a1019-guards.spec.ts — A-1019（窗口缩小时界面"出屏幕"）的结构守卫。
 *
 * 这一轮修的是三类**静默**缺陷 —— 它们不会让 tsc / vitest / 产物断言变红，
 * 只在"把窗口拖窄"这个动作下才现形，所以必须钉结构关系：
 *
 *  ① **布局地板只有一个来源**：三栏 min-width 之和（左 240 + 聊 380 + 右 260 = 880）。
 *     `.app` / `.body` 不许再声明更大的 min-width —— 那是一个"隐形地板"，
 *     会把整页钉宽、绕过三栏的自动收缩。（原病灶：`.app { min-width: 1100px }`，
 *     而窗口地板 WIN_MIN.width 只有 900 → 窗口能缩进 [900,1100) 死区，
 *     右栏连同标题栏右上角的开合按钮一起被推出屏幕外。）
 *  ② **侧栏宽度变量不许用百分比**：百分比在固有尺寸计算阶段不可解析 →
 *     外层 `.right-wrapper` 按内容 max-content 算出 431px（右栏真实 260px）→
 *     窄窗口下右栏先被顶出去。必须用 vw。
 *  ③ **两份比例数值必须同源**：CSS 的 clamp 中间值（17.5vw / 21.5vw）与
 *     App.tsx 的 SIDEBAR_RATIO（0.175 / 0.215）是同一个设计比例的两种表达，
 *     改一边忘一边就会出现"按比例算出来却不是比例"的旧毛病。
 *  ④ **`window.slimeAPI` 取出后必须有守卫**：否则 preload 未就绪时在渲染阶段抛异常，
 *     被 ErrorBoundary 拦下 → 整棵组件树被替换成"界面渲染出错"（整页白屏），
 *     而不是某个功能降级。（原病灶：TasksTab 里 `api.chat?.onChunk` —— 第二层带了
 *     可选链、第一层没带，照样崩。）
 *
 * 每一条都能通过变异测试验红。`assert-layout-fit.cjs` 是同一批不变量的**运行时**取证
 * （真实渲染 + 真实几何 + 截图）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const INDEX_CSS = join(ROOT, "gui/src/renderer/index.css");
const APP_TSX = join(ROOT, "gui/src/renderer/App.tsx");
const MAIN_INDEX = join(ROOT, "gui/src/main/index.ts");
const RENDERER_DIR = join(ROOT, "gui/src/renderer");

const read = (p: string): string => readFileSync(p, "utf8");

/** 取某个类选择器块里**所有** min-width 声明中的最后一个（`body, #root, .app {}` 这类
 *  选择器列表块会先命中，只取第一处会锁错对象 —— 变异测试当场抓出来过）。 */
function blockMinWidth(css: string, cls: string): number | null {
  const re = new RegExp(`\\.${cls} \\{([^}]*)\\}`, "g");
  let m: RegExpExecArray | null;
  let seen = false;
  let hit: number | null = null;
  while ((m = re.exec(css))) {
    seen = true;
    const mm = /min-width:\s*(\d+)px/.exec(m[1]);
    if (mm) { hit = Number(mm[1]); }
  }
  return seen ? (hit === null ? 0 : hit) : null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) { out.push(p); }
  }
  return out;
}

describe("A-1019 ①：布局地板只有一个来源（三栏 min-width 之和）", () => {
  const css = read(INDEX_CSS);
  const app = read(APP_TSX);
  const main = read(MAIN_INDEX);

  const sidebarMin = Number(/const SIDEBAR_MIN_W = (\d+)/.exec(app)![1]);
  const chatMin = Number(/const CHAT_MIN_W = (\d+)/.exec(app)![1]);
  const rightMin = Number(/\.right-sidebar \{[^}]*min-width:\s*(\d+)px/.exec(css)![1]);
  const floor = sidebarMin + chatMin + rightMin;

  it("`.app` / `.body` 不得声明超过三栏下限之和的 min-width", () => {
    for (const cls of ["app", "body"]) {
      const w = blockMinWidth(css, cls);
      expect(w, `取不到 .${cls} 的 min-width（守卫自己失效了）`).not.toBeNull();
      expect(
        w!,
        `.${cls} { min-width: ${w}px } > 三栏下限之和 ${floor}：这是比三栏 min-width 更硬的`
          + "「隐形地板」，会把整页钉宽（窗口缩到它以下时右栏与标题栏开合按钮被推出屏幕）。"
          + "布局地板应只由三栏 min-width 决定。",
      ).toBeLessThanOrEqual(floor);
    }
  });

  it("窗口最小宽度 ≥ 三栏下限之和（窗口不允许缩到布局装不下）", () => {
    const winMinW = Number(/const WIN_MIN = \{ width: (\d+), height: \d+ \}/.exec(main)![1]);
    expect(
      winMinW,
      `WIN_MIN.width ${winMinW} < 三栏下限之和 ${floor}（${sidebarMin}+${chatMin}+${rightMin}）`,
    ).toBeGreaterThanOrEqual(floor);
  });
});

describe("A-1019 ②：侧栏宽度变量必须是 vw（百分比在固有尺寸阶段不可解析）", () => {
  const css = read(INDEX_CSS);

  it("--sidebar-w / --right-sidebar-w 不含百分比", () => {
    const decls = [...css.matchAll(/--(sidebar-w|right-sidebar-w)\s*:\s*([^;]+);/g)];
    expect(decls.length, "两个宽度变量都必须存在").toBeGreaterThanOrEqual(2);
    for (const d of decls) {
      expect(
        d[2].includes("%"),
        `--${d[1]} 用了百分比（${d[2].trim()}）：百分比在固有尺寸计算阶段不可解析 → `
          + "flex item 退化成 auto → 外层容器按内容 max-content 撑宽（实测 431px vs 右栏真实 260px）"
          + " → 窄窗口下右栏先被顶出屏幕。请用 vw。",
      ).toBe(false);
    }
  });
});

describe("A-1019 ③：CSS 比例与 App.tsx 的 SIDEBAR_RATIO 同源", () => {
  const css = read(INDEX_CSS);
  const app = read(APP_TSX);

  it("clamp 的 vw 值与 SIDEBAR_RATIO 一致", () => {
    const ratio = /const SIDEBAR_RATIO = \{ left: ([\d.]+), right: ([\d.]+) \}/.exec(app);
    expect(ratio, "取不到 SIDEBAR_RATIO").toBeTruthy();
    const leftPct = Number(ratio![1]) * 100;
    const rightPct = Number(ratio![2]) * 100;

    const leftVw = /--sidebar-w:\s*clamp\([^,]+,\s*([\d.]+)vw/.exec(css);
    const rightVw = /--right-sidebar-w:\s*clamp\([^,]+,\s*([\d.]+)vw/.exec(css);
    expect(leftVw, "取不到 --sidebar-w 的 vw 值").toBeTruthy();
    expect(rightVw, "取不到 --right-sidebar-w 的 vw 值").toBeTruthy();

    expect(
      Number(leftVw![1]),
      `--sidebar-w 的 ${leftVw![1]}vw 与 SIDEBAR_RATIO.left（${leftPct}%）不一致：`
        + "两处是同一设计比例的两种表达，改一边忘一边 → 「按比例算出来却不是比例」。",
    ).toBeCloseTo(leftPct, 2);
    expect(
      Number(rightVw![1]),
      `--right-sidebar-w 的 ${rightVw![1]}vw 与 SIDEBAR_RATIO.right（${rightPct}%）不一致。`,
    ).toBeCloseTo(rightPct, 2);
  });
});

describe("A-1019 ⑤：标题栏 overlay 配色在**启动时**就必须对（不只是切换时纠正）", () => {
  const main = read(MAIN_INDEX);

  it("overlay 初值不得写死单色，必须读持久化主题", () => {
    const overlayDecl = /titleBarOverlay:\s*\{([^}]*)\}/.exec(main);
    expect(overlayDecl, "取不到 titleBarOverlay 初值声明").toBeTruthy();
    const body = overlayDecl![1];
    expect(
      /titleBarColors\(\s*readPersistedTheme\(\)\s*\)/.test(body),
      "`titleBarOverlay` 初值写死了固定配色 → alpha 主题用户每次启动都会先闪一帧 beta 色的色块"
        + "（那三个系统按钮背后一块比标题栏更深的色块）。初值必须来自 `titleBarColors(readPersistedTheme())`。",
    ).toBe(true);
  });

  it("配色只有一份实现，切换主题时同时持久化", () => {
    // 合成色字面量只允许出现在 titleBarColors 里（其它地方出现 = 又分叉了）
    const hexes = [...main.matchAll(/"#(0b101e|1e293b)"/g)];
    expect(
      hexes.length,
      `标题栏合成色字面量出现 ${hexes.length} 次：必须收敛到 titleBarColors() 一处，`
        + "否则改主题配色时会漏改某处 → 又出现色块。",
    ).toBeLessThanOrEqual(2);

    expect(main.includes("function titleBarColors("), "缺少 titleBarColors 唯一实现").toBe(true);
    const setter = /"slime:theme:set"[\s\S]{0,400}?\}\)/.exec(main);
    expect(setter, "取不到 slime:theme:set 处理体").toBeTruthy();
    expect(
      setter![0].includes("writePersistedTheme("),
      "slime:theme:set 没有持久化主题 → 下次启动读不到，overlay 初值又回到错的",
    ).toBe(true);
    expect(
      setter![0].includes("titleBarColors("),
      "slime:theme:set 没有走 titleBarColors（唯一实现）",
    ).toBe(true);
  });
});

describe("A-1019 ④：window.slimeAPI 取出后必须有守卫（否则整页白屏）", () => {
  /** 取 slimeAPI 的常见写法（单行） */
  const DECL = /const\s+(\w+)\s*=\s*\(window as unknown as \{\s*slimeAPI\?:[^}]*\}\)\.slimeAPI\s*;/;

  it("取值点之后、任何守卫生效之前，不得出现裸属性访问", () => {
    const offenders: string[] = [];
    for (const file of walk(RENDERER_DIR)) {
      const src = read(file);
      const lines = src.split("\n");
      const rel = file.replace(ROOT, "").replace(/\\/g, "/");
      lines.forEach((ln, i) => {
        const m = DECL.exec(ln);
        if (!m) { return; }
        const name = m[1];
        const guardNull = new RegExp(`if\\s*\\(\\s*!\\s*${name}\\b`);
        const guardPos = new RegExp(`if\\s*\\(\\s*${name}\\b`);
        const guardLogic = new RegExp(`\\b${name}\\s*(&&|\\?\\?|\\|\\|)`);
        const bare = new RegExp(`\\b${name}\\.[a-zA-Z_$]`);
        const optional = new RegExp(`\\b${name}\\?\\.`);
        const isComment = /^\s*(\/\/|\*|\/\*)/;

        let guarded = false;
        /* 作用域窗口：到本函数结束（行首 `}`）或下一个取值点为止 */
        for (let k = i + 1; k < lines.length; k++) {
          const L = lines[k];
          if (/^\}/.test(L)) { break; }
          if (DECL.test(L)) { break; }
          if (isComment.test(L)) { continue; }
          if (guardNull.test(L) || guardPos.test(L) || guardLogic.test(L)) { guarded = true; continue; }
          if (optional.test(L)) { continue; }
          if (bare.test(L) && !guarded) {
            offenders.push(`${rel}:${k + 1}  裸访问 ${name}${L.slice(L.indexOf(`${name}.`) + name.length).slice(0, 24)}…（取值点在第 ${i + 1} 行）`);
            break;
          }
        }
      });
    }
    expect(
      offenders,
      "这些位置取了 window.slimeAPI 却既没有 null 守卫、也不带第一层可选链：\n"
        + offenders.map((o) => `  · ${o}`).join("\n")
        + "\npreload 未就绪时会在渲染阶段抛异常（或 async 边界变成 unhandled rejection） → ErrorBoundary 把整棵组件树替换成「界面渲染出错」"
        + "（整页白屏），而不是让某个功能降级。",
    ).toEqual([]);
  });
});
