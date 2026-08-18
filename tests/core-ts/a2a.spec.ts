/**
 * tests/core-ts/a2a.spec.ts — A2A 总线 + 委托协议测试。
 * 对照 core/a2a.py 语义：注册/点对点/广播/drain/history/shared_context/协议标签解析/单例。
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  A2ABus,
  ServerA2ABus,
  parseDelegations,
  parseDelegationResults,
  parseBroadcast,
  stripDelegationTags,
  buildDelegationPrompt,
} from "../../core-ts/src/a2a.js";

afterEach(() => {
  ServerA2ABus.reset();
});

describe("A2ABus 消息总线", () => {
  it("点对点投递：send → drainAll 取出", () => {
    const bus = new A2ABus();
    bus.register("a");
    bus.register("b");
    const { msg, delivered } = bus.send("a", "b", "hello", "info");
    expect(delivered).toBe(true);
    expect(msg.to_agent).toBe("b");
    expect(bus.drainAll("b").map((m) => m.content)).toEqual(["hello"]);
    expect(bus.drainAll("b")).toEqual([]); // 取空
  });

  it("接收方未注册 → delivered=false + warning", () => {
    const bus = new A2ABus();
    bus.register("a");
    const { delivered } = bus.send("a", "ghost", "hi");
    expect(delivered).toBe(false);
    expect(bus.getWarnings().length).toBe(1);
    expect(bus.getWarnings()[0]).toContain("ghost");
  });

  it("broadcast 投递给除发送方外所有注册者", () => {
    const bus = new A2ABus();
    bus.register("a");
    bus.register("b");
    bus.register("c");
    const { delivered } = bus.send("a", "broadcast", "all");
    expect(delivered).toBe(true);
    expect(bus.drainAll("b").length).toBe(1);
    expect(bus.drainAll("c").length).toBe(1);
    expect(bus.drainAll("a")).toEqual([]); // 不投递给自己
  });

  it("无其他 Agent 的广播 → delivered=false + warning", () => {
    const bus = new A2ABus();
    bus.register("a");
    const { delivered } = bus.send("a", "broadcast", "solo");
    expect(delivered).toBe(false);
    expect(bus.getWarnings()[0]).toContain("broadcast");
  });

  it("getHistory：无参全量；带 agent 过滤 from/to/broadcast", () => {
    const bus = new A2ABus();
    bus.register("a");
    bus.register("b");
    bus.send("a", "b", "m1");
    bus.send("b", "a", "m2");
    bus.send("a", "broadcast", "m3");
    expect(bus.getHistory().length).toBe(3);
    expect(bus.getHistory("b").length).toBe(3); // 收件人视角
    expect(bus.getHistory("a").length).toBe(3); // 发件人 + 广播
  });

  it("MAX_CONTENT=100000 截断", () => {
    const bus = new A2ABus();
    bus.register("a");
    bus.register("b");
    bus.send("a", "b", "x".repeat(120000));
    expect(bus.drainAll("b")[0].content.length).toBe(100000);
  });

  it("MAX_HISTORY=500 修剪", () => {
    const bus = new A2ABus();
    bus.register("a");
    bus.register("b");
    for (let i = 0; i < 510; i++) {
      bus.send("a", "b", `m${i}`);
    }
    expect(bus.getHistory().length).toBe(500);
    expect(bus.getHistory()[0].content).toBe("m10");
  });

  it("getSharedContext：排除自己的消息 + 类型化渲染", () => {
    const bus = new A2ABus();
    bus.register("a");
    bus.register("b");
    bus.register("c");
    bus.send("a", "broadcast", "我自己的进展", "info");
    bus.send("b", "broadcast", "b 完成了", "done");
    bus.send("c", "broadcast", "c 警告", "alert");
    bus.send("b", "a", "回复你", "response");
    bus.send("c", "a", "请求", "request");
    const ctx = bus.getSharedContext("a");
    expect(ctx).not.toContain("我自己的进展");
    expect(ctx).toContain("[b] ✓ 已完成: b 完成了");
    expect(ctx).toContain("[c] ⚠ 警告: c 警告");
    expect(ctx).toContain("[b] 回复: 回复你");
    expect(ctx).toContain("[c] 请求: 请求");
  });

  it("空历史 shared_context 返回空串", () => {
    expect(new A2ABus().getSharedContext("a")).toBe("");
  });

  it("clear 清空队列/历史/警告", () => {
    const bus = new A2ABus();
    bus.register("a");
    bus.register("b");
    bus.send("a", "b", "x");
    bus.clear();
    expect(bus.getHistory()).toEqual([]);
    expect(bus.drainAll("b")).toEqual([]);
    expect(bus.getWarnings()).toEqual([]);
  });
});

describe("委托标记协议（N10-S1 平衡解析）", () => {
  it("单委托解析", () => {
    const items = parseDelegations('回复 <DELEGATE name="A">写周报</DELEGATE> 完毕');
    expect(items).toEqual([{ name: "A", task: "写周报" }]);
  });

  it("多委托 + 乱序文本", () => {
    const items = parseDelegations(
      '先说明：<DELEGATE name="B">任务二</DELEGATE> 与 <DELEGATE name="A">任务一</DELEGATE> 并行',
    );
    expect(items).toEqual([
      { name: "B", task: "任务二" },
      { name: "A", task: "任务一" },
    ]);
  });

  it("嵌套委托（深度计数）", () => {
    const items = parseDelegations(
      '<DELEGATE name="A">外层<DELEGATE name="B">内层</DELEGATE>尾部</DELEGATE>',
    );
    expect(items).toEqual([
      { name: "A", task: "外层<DELEGATE name=\"B\">内层</DELEGATE>尾部" },
    ]);
  });

  it("未闭合标签 → 不产出", () => {
    expect(parseDelegations('<DELEGATE name="A">没有闭合')).toEqual([]);
  });

  it("name 为空 → 跳过", () => {
    expect(parseDelegations('<DELEGATE name="">x</DELEGATE>')).toEqual([]);
  });

  it("任务内容截断至 2000 字符", () => {
    const items = parseDelegations(`<DELEGATE name="A">${"长".repeat(5000)}</DELEGATE>`);
    expect(items[0].task.length).toBe(2000);
  });

  it("parseDelegationResults / parseBroadcast", () => {
    const results = parseDelegationResults('<DELEGATE_RESULT name="A">结果1</DELEGATE_RESULT>');
    expect(results).toEqual([{ name: "A", result: "结果1" }]);
    expect(parseBroadcast("<BROADCAST>大家好</BROADCAST>")).toBe("大家好");
    expect(parseBroadcast("无广播")).toBeNull();
  });

  it("stripDelegationTags：嵌套 + 残留闭合清理", () => {
    const text =
      '开头<DELEGATE name="A">外层<DELEGATE name="B">内层</DELEGATE>尾</DELEGATE><DELEGATE_RESULT name="C">r</DELEGATE_RESULT><BROADCAST>b</BROADCAST>结尾';
    expect(stripDelegationTags(text)).toBe("开头结尾");
  });

  it("buildDelegationPrompt：点对点 + 广播说明", () => {
    const p = buildDelegationPrompt([{ name: "A", role: "研究员" }], ["主", "A"]);
    expect(p).toContain('<DELEGATE name="A">');
    expect(p).toContain("<BROADCAST>");
    expect(p).toContain("研究员");
  });

  it("buildDelegationPrompt：无子 Agent 时省略点对点段", () => {
    const p = buildDelegationPrompt([], ["主"]);
    expect(p).not.toContain("<DELEGATE");
    expect(p).not.toContain("<BROADCAST>");
  });
});

describe("ServerA2ABus 单例", () => {
  it("get() 返回构造实例；reset 置空", () => {
    expect(ServerA2ABus.get()).toBeNull();
    const bus = new ServerA2ABus();
    expect(ServerA2ABus.get()).toBe(bus);
    ServerA2ABus.reset();
    expect(ServerA2ABus.get()).toBeNull();
  });

  it("delegate / sendResult / broadcast / getRegisteredNames", () => {
    const bus = new ServerA2ABus();
    bus.register("主");
    bus.register("A");
    bus.register("B");
    const d = bus.delegate("主", "A", "去调研");
    expect(d.delivered).toBe(true);
    expect(d.msgId.length).toBeGreaterThan(0);
    const drained = bus.drainAll("A")[0];
    expect(drained.msg_type).toBe("request");
    bus.sendResult("A", "主", "调研完成", d.msgId);
    expect(bus.drainAll("主")[0].msg_type).toBe("response");
    const b = bus.broadcast("主", "全体注意", "info");
    expect(b.count).toBe(2);
    expect(b.delivered).toBe(true);
    expect(bus.getRegisteredNames()).toEqual(["主", "A", "B"]);
  });
});