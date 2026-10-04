

















import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../core-ts/src/paths.js";
import {
  pushSteer, dropSteer, drainSteers, pendingSteerCount, resetSteerBusForTest,
} from "../../core-ts/src/services/steerBus.js";

const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), "utf8");

beforeEach(() => { resetSteerBusForTest(); });

describe("A-1151 ① `dropSteer`：按 id 撤销单条", () => {
  it("删掉指定的那一条，其余原样留着", () => {
    pushSteer("s1", { id: "7", text: "甲" });
    pushSteer("s1", { id: "8", text: "乙" });
    pushSteer("s1", { id: "9", text: "丙" });
    expect(dropSteer("s1", "8")).toBe(true);
    
    expect(drainSteers("s1").map((i) => i.text)).toEqual(["甲", "丙"]);
  });

  it("id 不存在 / 会话不存在 ⇒ 返回 false（不抛、也不误删）", () => {
    pushSteer("s1", { id: "7", text: "甲" });
    expect(dropSteer("s1", "999")).toBe(false);
    expect(dropSteer("s2", "7")).toBe(false);      
    expect(dropSteer("", "7")).toBe(false);          
    expect(dropSteer(undefined, "7")).toBe(false);
    expect(pendingSteerCount("s1")).toBe(1);          
  });

  it("删到空 ⇒ 该会话的键被移除（不留空数组占位）", () => {
    pushSteer("s1", { id: "7", text: "甲" });
    expect(dropSteer("s1", "7")).toBe(true);
    expect(pendingSteerCount("s1")).toBe(0);
    expect(drainSteers("s1")).toEqual([]);           
  });
});

describe("A-1151 ② 接线：取消路径**真的**调到了它（缺一处就等于没修）", () => {
  it("`steerBus` 导出 `dropSteer`", () => {
    const src = read("core-ts/src/services/steerBus.ts");
    expect(src).toMatch(/export function dropSteer\(/);
  });

  it("主进程有**撤销**通道，且它真的调 `dropSteer`（不是只回个 ok）", () => {
    const src = read("gui/src/main/index.ts");
    expect(src).toContain('"slime:chat:steer:dismiss"');
    
    expect(src).toMatch(/slime:chat:steer:dismiss[\s\S]{0,600}?dropSteer\(/);
  });

  it("preload 暴露 `dismissSteer`（实现 + 类型声明**两处**都要在）", () => {
    const src = read("gui/src/preload/index.ts");
    expect(src).toContain('ipcRenderer.invoke("slime:chat:steer:dismiss"');
    expect(src).toMatch(/dismissSteer:\s*\(sessionId: string/);
  });

  it("渲染层 `removeQueueItem` 删完渲染层**必须**再通知主进程", () => {
    const src = read("gui/src/renderer/pages/ChatPanel.tsx");
    


    expect(src).toMatch(/function removeQueueItem\([\s\S]{0,400}?removeAt\([\s\S]{0,600}?dismissSteer\??\./);
  });
});
