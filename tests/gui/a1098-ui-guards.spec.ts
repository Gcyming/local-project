














import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { INHERIT_MODEL, toggleModelInPool } from "../../gui/src/renderer/pages/modelPool.js";

const readSrc = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

const resident = stripComments(readSrc("../../gui/src/renderer/pages/ResidentPanel.tsx"));
const css = readSrc("../../gui/src/renderer/index.css");



describe("A-1098 ① — 模型池勾选：草稿只由手势改，轮询只写已保存值", () => {
  it("T1 勾上 = 追加到末尾（顺序即优先级，新勾的优先级最低）", () => {
    expect(toggleModelInPool([], "a", true)).toEqual(["a"]);
    expect(toggleModelInPool(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleModelInPool(["a", "b"], "c", true)).toEqual(["a", "b", "c"]);
  });

  it("T2 取消勾选 = 只去掉它，其余顺序不变", () => {
    expect(toggleModelInPool(["a", "b", "c"], "a", false)).toEqual(["b", "c"]);
    expect(toggleModelInPool(["a", "b", "c"], "b", false)).toEqual(["a", "c"]);
    expect(toggleModelInPool(["a"], "zzz", false)).toEqual(["a"]); 
  });

  it("T3 重复勾上同一项 ⇒ 不产生重复，也不改变它的位置", () => {
    expect(toggleModelInPool(["a", "b"], "a", true)).toEqual(["a", "b"]);
  });

  it("T4 ⚠️ `inherit` 是占位不是档位 ⇒ 永远不许进池（无论勾/取消）", () => {
    expect(INHERIT_MODEL).toBe("inherit");
    expect(toggleModelInPool([], INHERIT_MODEL, true)).toEqual([]);
    expect(toggleModelInPool(["a"], INHERIT_MODEL, true)).toEqual(["a"]);
    expect(toggleModelInPool([INHERIT_MODEL, "a"], "b", true)).toEqual(["a", "b"]);
  });

  it("T5 非法入参一律原样返回（宁可'点了没反应'，不许塞进语义不明的值）", () => {
    expect(toggleModelInPool([], "", true)).toEqual([]);
    expect(toggleModelInPool([], undefined as unknown as string, true)).toEqual([]);
    expect(toggleModelInPool(["a", "", null as unknown as string], "b", true)).toEqual(["a", "b"]);
    expect(toggleModelInPool(undefined as unknown as string[], "a", true)).toEqual(["a"]);
  });

  it("T6 **不修改入参**（返回新数组，便于 React 判等 / 出错回滚）", () => {
    const src = ["a", "b"];
    const out = toggleModelInPool(src, "c", true);
    expect(src).toEqual(["a", "b"]);
    expect(out).not.toBe(src);
  });

  

  it("T7 【事故本体】4s 轮询 `refresh` **绝不写草稿**（写了就是用户看到的'自动取消勾选'）", () => {
    const refreshBody = /const refresh = React\.useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[api\]\);/.exec(resident)?.[1];
    expect(refreshBody, "refresh 回调必须存在（锚点失效）").toBeTruthy();
    expect(refreshBody!, "轮询不许碰草稿池 draftModels —— 否则未保存的勾选会被服务端快照回滚").not.toContain("setDraftModels");
    
    expect(refreshBody!).toContain("setDefaultModels(");
  });

  it("T8 弹层里勾选读写的是**草稿**，且走唯一纯函数", () => {
    expect(resident).toContain("const idx = draftModels.indexOf(o.value);");
    expect(resident).toContain("toggleModelInPool(prev, o.value, e.target.checked)");
    
    expect(resident).not.toContain("setDefaultModels(checked");
  });

  it("T9 保存提交的是**草稿**，并把规范化后的结果回写已保存池", () => {
    expect(resident).toContain("api.resident?.subagentSetModels?.(draftModels)");
    expect(resident).toContain("setDefaultModels(r.defaultModels);");
  });

  it("T10 打开弹层时**从已保存池播种草稿**（不播种的话弹层永远是空的）", () => {
    expect(resident).toMatch(/setDraftModels\(defaultModels\);\s*setModelModal\(true\);/);
  });

  it("T11 `inherit` 的唯一出处是 modelPool.ts（面板侧过滤选项也读它，不许再写字面量）", () => {
    expect(resident).toContain("o.value !== INHERIT_MODEL");
    expect(resident).not.toMatch(/o\.value !== "inherit"/);
  });
});



describe("A-1098 ② — 浮层实底：`--modal-surface`/`--float-surface` 不透明 + 全屏浮层恰好一个 `.modal-card`", () => {
  const rootBlock = /^:root\s*\{([\s\S]*?)\n\}/m.exec(css)?.[1] ?? "";
  const betaBlock = /:root\[data-theme="beta"\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

  
  const varOf = (block: string, name: string): string =>
    new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? "";

  
  const isOpaque = (v: string): boolean => {
    const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(v);
    if (!m) { return false; }
    const h = m[1];
    if (h.length === 4) { return h[3].toLowerCase() === "f"; }
    if (h.length === 8) { return h.slice(6).toLowerCase() === "ff"; }
    return true;
  };

  
  const lum = (v: string): number => {
    const m = /^#([0-9a-fA-F]{6})$/.exec(v);
    if (!m) { return 1; }
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };

  it("T12 两个主题块都定义得出来（锚点自检：正则没命中就会变成'空块也是绿'）", () => {
    expect(rootBlock.length, ":root 主题块没解析出来").toBeGreaterThan(100);
    expect(betaBlock.length, "beta 主题块没解析出来").toBeGreaterThan(100);
  });

  it("T13 【根因】`--float-surface` 在**每个**主题里都必须是不透明色", () => {
    for (const [name, block] of [["默认", rootBlock], ["beta", betaBlock]] as const) {
      const v = varOf(block, "float-surface");
      expect(v, `${name}主题缺 --float-surface`).not.toBe("");
      expect(isOpaque(v), `${name}主题的 --float-surface = ${v} 是**半透明**的 ⇒ 浮层会透出背后正文`).toBe(true);
    }
  });

  it("T14 `--bg` 也必须不透明（右栏「新建文件」弹窗与悬浮窗直接用它当实底）", () => {
    for (const [name, block] of [["默认", rootBlock], ["beta", betaBlock]] as const) {
      expect(isOpaque(varOf(block, "bg")), `${name}主题的 --bg 是半透明`).toBe(true);
    }
  });

  it("T15 `.modal-card` 只用 `--modal-surface`（⚠️ 不许再借 `--float-surface`），且自己不许再引入任何半透明写法", () => {
    const body = /(?:^|\n)\.modal-card\s*\{([\s\S]*?)\}/.exec(stripComments(css))?.[1];
    expect(body, ".modal-card 规则必须存在（浮层实底的唯一出处）").toBeTruthy();
    expect(body!).toContain("var(--modal-surface)");
    
    
    expect(body!,
      "A-1100：`.modal-card` 不许再借 `var(--float-surface)` —— beta 下它会取到蓝灰抬高色，"
      + "模态窗观感就串成 Alpha 主题配色（用户实测的那条回归）",
    ).not.toContain("var(--float-surface)");
    expect(body!, ".modal-card 里不许出现 rgba()/gradient —— 那就是第二个半透明真相源").not.toMatch(/rgba\(|linear-gradient|hsla\(/);
  });

  it("T20 【A-1100 回归】`--modal-surface` 两主题都是不透明色；beta 的模态底必须是**近黑**，不许取抬高面的蓝灰", () => {
    for (const [name, block] of [["默认", rootBlock], ["beta", betaBlock]] as const) {
      const v = varOf(block, "modal-surface");
      expect(v, `${name}主题缺 --modal-surface`).not.toBe("");
      expect(isOpaque(v), `${name}主题的 --modal-surface = ${v} 是**半透明**的 ⇒ 模态窗会透出背后正文`).toBe(true);
    }
    
    
    const betaModal = varOf(betaBlock, "modal-surface");
    const betaFloat = varOf(betaBlock, "float-surface");
    expect(betaModal,
      `beta 的 --modal-surface 又等于 --float-surface（${betaFloat}）—— 模态窗会再次被显示成 Alpha 配色`,
    ).not.toBe(betaFloat);
    
    
    expect(lum(betaModal),
      `beta 的 --modal-surface（${betaModal}）不够暗 —— 它应是近黑遮底色，而不是抬高卡片色（${betaFloat}）`,
    ).toBeLessThan(lum(betaFloat));
  });

  it("T16 【用法约束】`.modal-card` 必须**独立使用**，不许写成 `className=\"card modal-card\"`", () => {
    
    const bad = /className="[^"]*\bcard\b[^"]*modal-card|className="[^"]*modal-card[^"]*\bcard\b/;
    for (const f of MODAL_SITES.map((s) => s.file)) {
      expect(stripComments(readSrc(f)), `${f} 里不能给浮层同时挂 card 与 modal-card`).not.toMatch(bad);
    }
  });

  




  const MODAL_SITES = [
    { file: "../../gui/src/renderer/pages/SettingsDialog.tsx", n: 1, why: "设置主弹窗（各设置页都在里面）" },
    // 2026-10-07 A-1197：因「未保存改动离开确认弹窗」新增，AgentsPanel 的浮层数由 2 更新为 3。
    // 三个浮层分别是：① 创建 Agent（width 520，带工具能力选择）② 未保存改动离开确认（width 440）
    // ③ 删除 Agent（width 400）。三个都是有意保留的全屏浮层，不许挪走。
    { file: "../../gui/src/renderer/pages/AgentsPanel.tsx", n: 3, why: "创建 Agent / 未保存改动离开确认 / 删除 Agent" },
    { file: "../../gui/src/renderer/pages/ProvidersPanel.tsx", n: 1, why: "添加 / 编辑供应商（1000px 大弹窗）" },
    { file: "../../gui/src/renderer/pages/NewProjectDialog.tsx", n: 1, why: "新建会话" },
    { file: "../../gui/src/renderer/pages/ResidentPanel.tsx", n: 1, why: "【用户本次反馈】子代理执行模型多选弹层" },
    { file: "../../gui/src/renderer/pages/SubAgentModal.tsx", n: 1, why: "子代理运行详情" },
    { file: "../../gui/src/renderer/App.tsx", n: 1, why: "本地模型加载进度弹窗" },
  ] as const;

  it("T17 每个全屏浮层恰好一个 `.modal-card` 面板（数量必须对上）", () => {
    






    for (const s of MODAL_SITES) {
      const body = stripComments(readSrc(s.file));
      const overlays = [...body.matchAll(/position:\s*"fixed",\s*inset:\s*0/g)].length;
      const panels = [...body.matchAll(/className="modal-card"/g)].length;
      expect(overlays, `${s.file}（${s.why}）全屏浮层数变了：期望 ${s.n}，实际 ${overlays}`).toBe(s.n);
      expect(panels,
        `${s.file}（${s.why}）实底面板数 = ${panels} ≠ 浮层数 ${overlays}。`
        + `浮层面板请写 className="modal-card"（不要用 className="card" —— beta 主题下它是 0.42/0.5 半透明渐变，会透出背后正文）`,
      ).toBe(overlays);
    }
  });

  it("T18 两个被排除的全屏浮层必须**自证**是实底（排除不是「忘了改」）", () => {
    





    const rightSidebar = stripComments(readSrc("../../gui/src/renderer/pages/RightSidebar.tsx"));
    expect(rightSidebar, "右栏新建弹窗的实底来源变了（== 它开始半透明）").toContain('background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: 20');
    const errBoundary = stripComments(readSrc("../../gui/src/renderer/ErrorBoundary.tsx"));
    expect(errBoundary, "崩溃页的实底变了（== 它开始半透明）").toContain('background: "#0b1020"');
  });

  it("T19 浮层面板**自己**不许再声明 background（实底只能来自 `.modal-card` —— 防第二个真相源）", () => {
    // 2026-10-07 A-1197：AgentsPanel 的期望值随T17 同步由 2 更新为 3（多了「未保存改动离开确认」浮层）。
    // ⚠️ 本守卫的**本意不变**：浮层面板一律不许自己声明 background —— 断言仍逐个面板在跑，
    // 只是被检查的面板从 2 个变成 3 个（第三个 = AgentsPanel.tsx 里width 440 的离开确认卡，
    // 它同样只能靠 .modal-card 拿实底）。计数是精确相等，不是 >=。
    













    const MASKS = /background:\s*"rgba\((?:0,\s*0,\s*0|2,\s*6,\s*23)[^"]*"/g;

    
    const styleBlocksAround = (body: string, at: number): string[] => {
      const out: string[] = [];
      const fwd = body.indexOf("style={{", at);
      if (fwd >= 0 && fwd - at < 400) {
        const end = body.indexOf("}}", fwd);
        out.push(body.slice(fwd, end < 0 ? Math.min(body.length, fwd + 600) : end + 2));
      }
      const bwd = body.lastIndexOf("style={{", at);
      if (bwd >= 0 && at - bwd < 1200) {
        const end = body.indexOf("}}", bwd);
        out.push(body.slice(bwd, end < 0 ? at : end + 2));
      }
      return out;
    };

    for (const s of MODAL_SITES) {
      const body = stripComments(readSrc(s.file)).replace(MASKS, "<<mask>>");
      const hits = [...body.matchAll(/className="modal-card"/g)];
      expect(hits.length, `${s.file} 的 modal-card 面板数变了`).toBe(s.n);
      for (const h of hits) {
        const blocks = styleBlocksAround(body, h.index!);
        expect(blocks.length, `${s.file} 的 modal-card 附近找不到 style 块（锚点失效）`).toBeGreaterThan(0);
        for (const b of blocks) {
          expect(b, `${s.file} 的浮层面板自带 background ⇒ 会盖过 .modal-card 的实底：${b}`).not.toMatch(/background\s*:/);
        }
      }
    }
  });
});
