/**
 * gui-network-toggle.spec.ts — 「联网搜索」开关的口径守卫（A-1008）。
 *
 * 事故（用户表现为"群聊搜不了"，且**没有任何提示**）：
 * 同一个开关的持久化口径有**两份实现**——
 *   - `ChatPanel.tsx`：`localStorage.getItem(KEY) !== "0"` → 没存过 = **开**
 *   - `App.tsx`：`localStorage.getItem(KEY) === "1"` → 没存过 = **关**
 * 于是"从没点过开关"的用户：主聊天能联网，而欢迎语那条流把 `web_search/web_fetch`
 * 静默拒掉（工具被过滤掉，模型只能编）。这类"一个规则两处实现"是本项目反复踩的坑
 * （取价优先级已因此出过两次事故），所以口径收敛到 `gui/src/renderer/networkToggle.ts`，
 * 并用源码守卫钉死"不许再出现第二处字面量"。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readNetworkEnabled, writeNetworkEnabled, NETWORK_TOGGLE_KEY } from "../../gui/src/renderer/networkToggle.js";

/** 极简 localStorage 替身（够用即可：只测 getItem/setItem 的语义） */
function fakeStorage(init: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  } as Storage;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("readNetworkEnabled（未显式存过 = 开）", () => {
  it("从没存过 → true（A-966 的结论：默认关会让工具被静默拒绝）", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    expect(readNetworkEnabled()).toBe(true);
  });

  it("显式存过 \"0\" → false；存过 \"1\" → true", () => {
    vi.stubGlobal("localStorage", fakeStorage({ [NETWORK_TOGGLE_KEY]: "0" }));
    expect(readNetworkEnabled()).toBe(false);
    vi.stubGlobal("localStorage", fakeStorage({ [NETWORK_TOGGLE_KEY]: "1" }));
    expect(readNetworkEnabled()).toBe(true);
  });

  it("存了别的值（历史脏数据）→ 按开处理", () => {
    vi.stubGlobal("localStorage", fakeStorage({ [NETWORK_TOGGLE_KEY]: "true" }));
    expect(readNetworkEnabled()).toBe(true);
  });

  it("localStorage 不可用（隐私模式抛错）→ 退化为开，不抛给调用方", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
    } as unknown as Storage);
    expect(readNetworkEnabled()).toBe(true);
    expect(() => writeNetworkEnabled(false)).not.toThrow();
  });
});

describe("writeNetworkEnabled（只写 \"1\"/\"0\"）", () => {
  it("写入后能被自己读回（往返一致）", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    writeNetworkEnabled(false);
    expect(readNetworkEnabled()).toBe(false);
    writeNetworkEnabled(true);
    expect(readNetworkEnabled()).toBe(true);
  });

  it("写入值是字面量 \"1\"/\"0\"（便于人肉排查 localStorage）", () => {
    const st = fakeStorage();
    vi.stubGlobal("localStorage", st);
    writeNetworkEnabled(true);
    expect(st.getItem(NETWORK_TOGGLE_KEY)).toBe("1");
    writeNetworkEnabled(false);
    expect(st.getItem(NETWORK_TOGGLE_KEY)).toBe("0");
  });
});

/* ═══════════ 源码守卫：开关字面量只允许出现在 networkToggle.ts ═══════════ */
describe("结构守卫：联网开关只有一个实现", () => {
  const ROOT = new URL("../../", import.meta.url); // tests/core-ts/ → 仓库根
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, out); }
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) { out.push(p); }
    }
    return out;
  };

  it("gui/src 下只有 renderer/networkToggle.ts 出现 slime_network_enabled 字面量", () => {
    const files = walk(fileURLToPath(new URL("gui/src/", ROOT)));
    expect(files.length).toBeGreaterThan(20); // 扫描有效（防路径写错导致空转通过）
    const offenders: string[] = [];
    for (const f of files) {
      // 去掉注释再看：注释里提到键名是允许的（本文件的注释就提到了），只禁**代码里**再用一次
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      if (/slime_network_enabled/.test(src) && !f.endsWith("networkToggle.ts")) {
        offenders.push(f);
      }
    }
    expect(offenders, "联网开关的存储键只允许出现在 networkToggle.ts —— 多处读一份偏好必然出现两个默认值").toEqual([]);
  });

  it("反向确认：networkToggle.ts 里确实有那个键（否则上面那条等于空转）", () => {
    const src = readFileSync(new URL("gui/src/renderer/networkToggle.ts", ROOT), "utf8");
    expect(src).toContain("slime_network_enabled");
  });

  it("App.tsx / ChatPanel.tsx 都走 readNetworkEnabled（不再各写一份 localStorage 口径）", () => {
    const app = readFileSync(new URL("gui/src/renderer/App.tsx", ROOT), "utf8");
    const panel = readFileSync(new URL("gui/src/renderer/pages/ChatPanel.tsx", ROOT), "utf8");
    expect(app).toMatch(/readNetworkEnabled\s*\(/);
    expect(panel).toMatch(/readNetworkEnabled\s*\(/);
    expect(app).not.toMatch(/localStorage\.getItem\(\s*["']slime_network_enabled/);
    expect(panel).not.toMatch(/localStorage\.getItem\(\s*["']slime_network_enabled/);
  });

  /*
   * A-1008 的界面构成问题：开关原本长在 `{sessionType === "brainstorm" ? null : (<>…</>)}`
   * 这个「群聊隐藏块」里面 —— 群聊照样会调 web_search/web_fetch，但用户在群聊里既看不到
   * 也控不了联网（A-966 的"群聊搜不了"其实一半来自这里：看不到开关 → 不知道被关了）。
   *
   * 为什么用"位置"而不是"是否存在"做判据：文案 `联网搜索` 在两种写法里都存在，
   * 断言它存在**证明不了**它没被藏起来。真正的判据是它出现在那个 `<>` 片段**闭合之后**。
   */
  it("联网开关长在群聊隐藏块之外（群聊里可见可点）", () => {
    const src = readFileSync(new URL("gui/src/renderer/pages/ChatPanel.tsx", ROOT), "utf8")
      .replace(/\r\n/g, "\n");
    const blockStart = src.indexOf('sessionType === "brainstorm" ? null : (');
    expect(blockStart, "找不到群聊隐藏块的起点（若已重写，请同步更新本守卫）").toBeGreaterThan(-1);
    const fragmentEnd = src.indexOf("</>", blockStart);
    expect(fragmentEnd, "群聊隐藏块的片段没有闭合标记（结构已变，请复核本守卫）").toBeGreaterThan(-1);
    const toggleAt = src.indexOf("联网搜索开关（A-1008", blockStart);
    expect(toggleAt, "找不到联网开关（它必须还在，只是不该藏在群聊隐藏块里）").toBeGreaterThan(-1);
    expect(
      toggleAt,
      "联网开关又回到群聊隐藏块里面了 —— 群聊会调 web_search/web_fetch，用户却看不到也控不了",
    ).toBeGreaterThan(fragmentEnd);
  });
});
