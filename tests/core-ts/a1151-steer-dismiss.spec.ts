/**
 * tests/core-ts/a1151-steer-dismiss.spec.ts — 「取消引导必须真的取消」的守卫（A-1151）。
 *
 * ## 用户实测 bug
 * 「这两个引导都是我点击了**取消叉**后的情况，结果**后面都传上去了**，是不是取消功能有问题？」
 *
 * ## 缺口在哪（为什么单测纯函数不够）
 * 点「引导」箭头后，这条引导在**两个地方**各有一份：
 *   ① 渲染层待发卡片（`interruptQueueRef`）—— `✕` 删的是它；
 *   ② 主进程 `steerBus` 缓冲 —— 等着被工具循环在轮次边界消费。
 * 而 `✕` 原本**只删 ①**，② 里的残留一直挂着 ⇒ 本轮走到轮次边界、或（纯文本回答走不到边界时）
 * 残留留到下一次运行时被注入 ⇒ **用户明明取消了，还是被发出去了**。
 * `clearSteers` 只在**流结束**时全清，救不了"流还在跑时用户取消"这一段。
 *
 * ⇒ 光有 `dropSteer` 这个纯函数**不够**：还要保证**取消路径真的调到了它**。
 * 本组因此分两层：**纯函数行为**（3 例）+ **四处接线**（缺一处就等于没修）。
 */

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
    /* ⚠️ 断言**剩下的内容**而不只是条数：只锁条数的话，"删错了哪一条"这类变异照样绿。 */
    expect(drainSteers("s1").map((i) => i.text)).toEqual(["甲", "丙"]);
  });

  it("id 不存在 / 会话不存在 ⇒ 返回 false（不抛、也不误删）", () => {
    pushSteer("s1", { id: "7", text: "甲" });
    expect(dropSteer("s1", "999")).toBe(false);
    expect(dropSteer("s2", "7")).toBe(false);      // 另一个会话
    expect(dropSteer("", "7")).toBe(false);          // 空会话
    expect(dropSteer(undefined, "7")).toBe(false);
    expect(pendingSteerCount("s1")).toBe(1);          // 没被误伤
  });

  it("删到空 ⇒ 该会话的键被移除（不留空数组占位）", () => {
    pushSteer("s1", { id: "7", text: "甲" });
    expect(dropSteer("s1", "7")).toBe(true);
    expect(pendingSteerCount("s1")).toBe(0);
    expect(drainSteers("s1")).toEqual([]);           // 再取一次仍是空，不报错
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
    /* ⚠️ 必须锚"调用点"：只锁 IPC 名字的话，把 handler 换成空实现照样绿。 */
    expect(src).toMatch(/slime:chat:steer:dismiss[\s\S]{0,600}?dropSteer\(/);
  });

  it("preload 暴露 `dismissSteer`（实现 + 类型声明**两处**都要在）", () => {
    const src = read("gui/src/preload/index.ts");
    expect(src).toContain('ipcRenderer.invoke("slime:chat:steer:dismiss"');
    expect(src).toMatch(/dismissSteer:\s*\(sessionId: string/);
  });

  it("渲染层 `removeQueueItem` 删完渲染层**必须**再通知主进程", () => {
    const src = read("gui/src/renderer/pages/ChatPanel.tsx");
    /* ⚠️ 顺序也要锁：先删渲染层、再撤销缓冲。
       ⚠️ 正则用 `dismissSteer\??\.` —— 代码里是**可选调用** `dismissSteer?.(...)`，
       写成 `dismissSteer\(` 匹配不到（第一版就栽在这，白跑一次）。 */
    expect(src).toMatch(/function removeQueueItem\([\s\S]{0,400}?removeAt\([\s\S]{0,600}?dismissSteer\??\./);
  });
});
