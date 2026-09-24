/**
 * tests/core-ts/a1069-agentprocs.spec.ts — #226「Agent 启动的后台进程」面板守卫
 *
 * 用户原话：「请把 Agent 停下时的后台进程做一个……在输入栏上方的按钮，而且点击后可以展开」。
 * 范围由用户明确划定：**仅 Agent 启动的进程**（应用自身服务不算 —— 关掉它等于把应用打瘸）。
 *
 * 判据全在纯模块 `core-ts/src/services/agentProcs.ts`（不 import electron）——
 * 所以这里能**行为断言**，而不是只能锁源码形态。这是本仓推崇的形态：
 * 判据住纯模块、组件只调用。
 *
 * ⚠️ 中文串里嵌引用一律 `「」`：ASCII 双引号会当场把 TS 字符串截断（a1054/a1055/a1056/a1067/a1068 都踩过）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_PROC_KINDS,
  AGENT_PROC_KIND_LABELS,
  AGENT_PROC_STOP_ACTIONS,
  buildAgentProcView,
  formatElapsed,
  isAgentStartedKind,
  isSubagentLive,
  planAgentProcStop,
  subagentStatusLabel,
  type AgentProcSources,
} from "../../core-ts/src/services/agentProcs.js";

/* H 段（接线守卫）读源码用：注释一律剥掉再断言，避免注释里的同一个词把 toContain 喂饱（§8-1）。 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("A-1069-A 范围：只有「Agent 启动的」才进面板（应用服务明确排除）", () => {
  it("三类就是 Agent 工具能起、且停下后仍然活着的三类", () => {
    expect([...AGENT_PROC_KINDS]).toEqual(["screen-host", "http-server", "subagent"]);
  });

  it("每一类都有中文名与停止动作（新增类别漏配这两样 = 面板上出现无法停止的条目）", () => {
    for (const k of AGENT_PROC_KINDS) {
      expect(AGENT_PROC_KIND_LABELS[k], `${k} 缺中文名`).toBeTruthy();
      expect(AGENT_PROC_STOP_ACTIONS[k], `${k} 缺停止动作`).toBeTruthy();
    }
    expect(Object.keys(AGENT_PROC_KIND_LABELS).sort()).toEqual([...AGENT_PROC_KINDS].sort());
    expect(Object.keys(AGENT_PROC_STOP_ACTIONS).sort()).toEqual([...AGENT_PROC_KINDS].sort());
  });

  it("isAgentStartedKind：认这三类，认不出应用服务名（它们根本不该进 sources）", () => {
    for (const k of AGENT_PROC_KINDS) { expect(isAgentStartedKind(k)).toBe(true); }
    for (const bad of ["llama-server", "python-backend", "mcp", "silam", "electron", "", "http-server "]) {
      expect(isAgentStartedKind(bad), `${bad || "(空串)"} 不该被认成 Agent 启动的资源`).toBe(false);
    }
  });

  it("空真源 → 视图为空（`any=false` ⇒ 组件不渲染按钮，不留空壳）", () => {
    const v = buildAgentProcView({}, 1_000);
    expect(v.count).toBe(0);
    expect(v.any).toBe(false);
    expect(v.entries).toEqual([]);
  });

  it("三类齐全时才三条 —— 且**只**来自传进来的真源（没有第四条来源）", () => {
    const v = buildAgentProcView({
      screenHost: { pid: 4242, startedAt: 0 },
      httpServers: [{ id: "s1", port: 8080, dir: "D:/x", startedAt: 0 }],
      subagents: [{ id: "a1", name: "研究员", status: "running", startedAt: 0 }],
    }, 5_000);
    expect(v.count).toBe(3);
    expect(v.entries.map((e) => e.kind)).toEqual(["screen-host", "http-server", "subagent"]);
  });
});

describe("A-1069-B 图形控制宿主（screen_* 起的常驻 PowerShell 进程）", () => {
  it("有宿主 → 一条，带 pid 与「常驻」状态", () => {
    const v = buildAgentProcView({ screenHost: { pid: 1234, startedAt: 0 } }, 30_000);
    const e = v.entries[0];
    expect(e.kind).toBe("screen-host");
    expect(e.detail).toContain("1234");
    expect(e.status).toBe("常驻");
    expect(e.id, "宿主是全局唯一的，停止请求不带 id").toBe("");
  });

  it("pid 拿不到时如实说明，不显示 undefined", () => {
    const v = buildAgentProcView({ screenHost: { startedAt: 0 } }, 1_000);
    expect(v.entries[0].detail).not.toContain("undefined");
    expect(v.entries[0].detail).toContain("常驻");
  });

  it("screenHost 为 null/undefined → 没有这条（绝大多数时候都没起）", () => {
    expect(buildAgentProcView({ screenHost: null }, 1).count).toBe(0);
    expect(buildAgentProcView({}, 1).count).toBe(0);
  });
});

describe("A-1069-C 本地 HTTP 服务（http_serve 起的监听，跨轮次存活）", () => {
  it("展示端口与目录，状态「监听中」", () => {
    const v = buildAgentProcView({
      httpServers: [{ id: "svc-1", port: 8080, dir: "D:/pilot project/dist", startedAt: 0, requests: 12 }],
    }, 1_000);
    const e = v.entries[0];
    expect(e.kind).toBe("http-server");
    expect(e.id, "停止要靠这个 id").toBe("svc-1");
    expect(e.label).toContain("8080");
    expect(e.detail).toContain("dist");
    expect(e.detail).toContain("12");
    expect(e.status).toBe("监听中");
  });

  it("监听 0.0.0.0 时**显式**标出来（局域网可访问 ≠ 仅本机，用户要能一眼分辨）", () => {
    const v = buildAgentProcView({
      httpServers: [{ id: "s", port: 8080, host: "0.0.0.0", dir: "D:/x", startedAt: 0 }],
    }, 1);
    expect(v.entries[0].label).toContain("0.0.0.0");
  });

  it("仅本机监听不啰嗦（默认值不该出现在标签里）", () => {
    const v = buildAgentProcView({
      httpServers: [{ id: "s", port: 8080, host: "127.0.0.1", dir: "D:/x", startedAt: 0 }],
    }, 1);
    expect(v.entries[0].label).not.toContain("127.0.0.1）");
  });

  it("多个服务全部列出（不折叠、不取前 N）", () => {
    const v = buildAgentProcView({
      httpServers: [
        { id: "a", port: 8080, dir: "D:/a", startedAt: 0 },
        { id: "b", port: 8081, dir: "D:/b", startedAt: 0 },
      ],
    }, 1);
    expect(v.count).toBe(2);
    expect(v.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("超长路径中间省略（面板只有一行，尾部更有信息量）", () => {
    const long = "D:/" + "very-long-segment/".repeat(8) + "dist";
    const v = buildAgentProcView({ httpServers: [{ id: "s", port: 1, dir: long, startedAt: 0 }] }, 1);
    expect(v.entries[0].detail).toContain("…");
    expect(v.entries[0].detail.length).toBeLessThan(long.length);
  });
});

describe("A-1069-D 后台子代理：只收还在跑的（终态条目会变成「点了没反应」）", () => {
  it("running/pending 进面板，终态**不进**", () => {
    const v = buildAgentProcView({
      subagents: [
        { id: "r", name: "研究员", status: "running", startedAt: 0 },
        { id: "p", name: "排队者", status: "pending", startedAt: 0 },
        { id: "d", name: "完成者", status: "done", startedAt: 0 },
        { id: "f", name: "失败者", status: "fail", startedAt: 0 },
        { id: "t", name: "超时者", status: "timeout", startedAt: 0 },
        { id: "c", name: "取消者", status: "cancelled", startedAt: 0 },
      ],
    }, 1_000);
    expect(v.entries.map((e) => e.id)).toEqual(["r", "p"]);
  });

  it("isSubagentLive 的判据（唯一出处，组件不许自己写 == \"running\"）", () => {
    expect(isSubagentLive("running")).toBe(true);
    expect(isSubagentLive("pending")).toBe(true);
    for (const s of ["done", "fail", "timeout", "cancelled", undefined, ""]) {
      expect(isSubagentLive(s), `${String(s)} 不该算「还在跑」`).toBe(false);
    }
  });

  it("状态词映射照实说（不把终态说成运行中）", () => {
    expect(subagentStatusLabel("running")).toBe("运行中");
    expect(subagentStatusLabel("pending")).toBe("排队中");
    expect(subagentStatusLabel("done")).toBe("已完成");
    expect(subagentStatusLabel("timeout")).toBe("超时");
    expect(subagentStatusLabel(undefined)).toBe("已派出");
  });

  it("任务描述进 detail 并压平空白（换行会把一行撑成多行）", () => {
    const v = buildAgentProcView({
      subagents: [{ id: "a", name: "研究员", status: "running", task: "调研\n\n  某主题  ", startedAt: 0 }],
    }, 1);
    expect(v.entries[0].detail).toBe("调研 某主题");
  });

  it("没有任务描述时如实说明（不留空字段让人以为是渲染坏了）", () => {
    const v = buildAgentProcView({ subagents: [{ id: "a", name: "研究员", status: "running" }] }, 1);
    expect(v.entries[0].detail).toBe("（无任务描述）");
  });
});

describe("A-1069-E 时长与排序", () => {
  it("formatElapsed：刚刚 / 秒 / 分秒 / 小时分", () => {
    expect(formatElapsed(1_000, 1_000)).toBe("刚刚");
    expect(formatElapsed(0, 999)).toBe("刚刚");
    expect(formatElapsed(0, 5_000)).toBe("5 秒");
    expect(formatElapsed(0, 60_000)).toBe("1 分");
    expect(formatElapsed(0, 130_000)).toBe("2 分 10 秒");
    expect(formatElapsed(0, 3_600_000)).toBe("1 小时");
    expect(formatElapsed(0, 3_900_000)).toBe("1 小时 5 分");
  });

  it("时钟回拨（负数）不显示负时长", () => {
    expect(formatElapsed(10_000, 0)).toBe("刚刚");
  });

  it("拿不到时刻时长留空（不显示 0 秒这种假数字）", () => {
    expect(formatElapsed(undefined, 1_000)).toBe("");
    expect(formatElapsed(NaN, 1_000)).toBe("");
  });

  it("排序：先按类别顺序，同类内先起的在上面", () => {
    const v = buildAgentProcView({
      subagents: [
        { id: "late", name: "后起", status: "running", startedAt: 5_000 },
        { id: "early", name: "先起", status: "running", startedAt: 1_000 },
      ],
      httpServers: [{ id: "h", port: 80, dir: "D:/h", startedAt: 9_999 }],
      screenHost: { startedAt: 9_999 },
    }, 10_000);
    expect(v.entries.map((e) => e.id)).toEqual(["", "h", "early", "late"]);
  });
});

describe("A-1069-F 停止请求：合法才给动作，非法必须拒绝（不许静默什么都不做）", () => {
  it("三类各自的动作", () => {
    expect(planAgentProcStop({ kind: "screen-host" })).toEqual({ ok: true, action: "dispose-screen-host", id: "" });
    expect(planAgentProcStop({ kind: "http-server", id: "svc-1" }))
      .toEqual({ ok: true, action: "stop-http-server", id: "svc-1" });
    expect(planAgentProcStop({ kind: "subagent", id: "run-9" }))
      .toEqual({ ok: true, action: "cancel-subagent", id: "run-9" });
  });

  it("未知类别 → 拒绝（否则主进程会走到不存在的分支，而界面已乐观划掉）", () => {
    for (const k of ["llama-server", "python-backend", "mcp", "", undefined]) {
      const r = planAgentProcStop({ kind: k as string });
      expect(r.ok, `${String(k)} 应被拒绝`).toBe(false);
    }
  });

  it("未知类别**即使带了 id** 也拒绝（带 id 会把 `AGENT_PROC_STOP_ACTIONS[kind]` 取成 undefined）", () => {
    /* ⚠️ 这条是补的：只测"不带 id"会被下面的 id 校验兜住 → 类别判据被删掉也照样绿
       （变异 A11 实测"仍绿"）。必须让"带 id 的自造类别"也成为断言对象，类别判据才真的被锁住。 */
    for (const k of ["llama-server", "python-backend", "mcp", "screenhost", "screen-host "]) {
      expect(planAgentProcStop({ kind: k, id: "x" }).ok, `${k} 带 id 也不该通过`).toBe(false);
    }
  });

  it("http-server / subagent 缺 id → 拒绝（停哪个无从谈起）", () => {
    for (const kind of ["http-server", "subagent"] as const) {
      expect(planAgentProcStop({ kind }).ok).toBe(false);
      expect(planAgentProcStop({ kind, id: "" }).ok).toBe(false);
      expect(planAgentProcStop({ kind, id: "   " }).ok).toBe(false);
    }
  });

  it("id 两端空白被修掉（界面传入的 id 带空格不该导致停不掉）", () => {
    expect(planAgentProcStop({ kind: "http-server", id: " svc-1 " })).toEqual({ ok: true, action: "stop-http-server", id: "svc-1" });
  });

  it("screen-host 是全局唯一的：不带 id 也合法（且动作里 id 恒为空）", () => {
    expect(planAgentProcStop({ kind: "screen-host", id: "随便" })).toEqual({ ok: true, action: "dispose-screen-host", id: "" });
  });

  it("拒绝时给得出原因（界面要如实说，不能静默）", () => {
    const a = planAgentProcStop({ kind: "nope" });
    const b = planAgentProcStop({ kind: "http-server" });
    expect(a.ok === false && a.reason.length > 0).toBe(true);
    expect(b.ok === false && b.reason.length > 0).toBe(true);
  });
});

describe("A-1069-G 视图与真源不共享可变结构（面板渲染不会反向污染服务状态）", () => {
  it("两次派生各拿各的数组；改动一个不影响另一个", () => {
    const src: AgentProcSources = { httpServers: [{ id: "a", port: 1, dir: "D:/a", startedAt: 0 }] };
    const v1 = buildAgentProcView(src, 1);
    v1.entries.pop();
    const v2 = buildAgentProcView(src, 1);
    /* ⚠️ `count` 是派生那一刻的**快照**（数组被 pop 也不会变），所以只断言 count 会漏掉
       "两次派生共享同一个数组实例"这种实现（变异 A15 实测"仍绿"）。必须直接断言数组。 */
    expect(v2.count).toBe(1);
    expect(v2.entries, "两次派生共享了同一个数组实例 → 一处 pop 会污染另一处").toHaveLength(1);
    expect(v1.entries, "返回的是同一个数组引用").not.toBe(v2.entries);
  });
});

/* ══ H 段：接线守卫 ═══════════════════════════════════════════════════════════
 *
 * 上面 A~G 段用**行为断言**锁住了判据（纯模块，不 import electron，能直接跑）。
 * 但用户那句需求里有一半是**接线事实**，行为断言碰不到：
 *   ·「在**输入栏上方**的按钮」→ 面板与 textarea 的 DOM 顺序；
 *   ·「点击后可以展开」→ 有展开态与条目渲染；
 *   ·「Agent 停下时」→ 回合结束广播；
 *   · 面板不许自己判类别（否则"显示的"与"主进程认为的"会漂移）。
 * 这类事实**过 tsc、过构建、过 A~G 全部测试**，只在用户眼里翻车（本仓 §21 反复强调），
 * 所以必须单独锁，并且每一条都要能被变异弄红。
 *
 * ⚠️ 断言一律先 `strip()` 剥注释 —— 否则注释里出现同一个词就会把 toContain 喂饱
 *   （本仓 §8-1 的"同名多产地"陷阱）。取函数体一律用**下一个兄弟声明**当右界，
 *   不许用固定字数窗口（a1061/a1068 都被这个坑咬过）。 */
describe("A-1069-H 接线：面板在输入栏上方 / 判据不在渲染层 / 主进程现算+先校验", () => {
  const PANEL = read("gui/src/renderer/pages/ChatPanel.tsx");
  const PANEL_C = strip(PANEL);
  const MAIN_C = strip(read("gui/src/main/index.ts"));
  const PRELOAD_C = strip(read("gui/src/preload/index.ts"));

  /** 取一段源码：`sig` 起点 → `nextSig` 起点（下一个兄弟声明）。
   *  ⚠️ 不用固定字数窗口：注释剥掉后长度会变，字数窗口必然假红或假绿。 */
  function between(src: string, sig: string, nextSig: string): string {
    const at = src.indexOf(sig);
    expect(at, `锚点漂移：找不到 ${sig}`).toBeGreaterThan(-1);
    const end = src.indexOf(nextSig, at + sig.length);
    expect(end, `锚点漂移：找不到 ${sig} 的右界 ${nextSig}`).toBeGreaterThan(at);
    return src.slice(at, end);
  }

  it("面板在**输入框上方**（用户原话：「在输入栏上方的按钮」—— 位置错了等于没做）", () => {
    const panel = PANEL_C.indexOf("{agentProcs?.any && (");
    const ta = PANEL_C.indexOf("<textarea ref={inputRef}");
    expect(panel, "找不到后台资源面板渲染块").toBeGreaterThan(-1);
    expect(ta, "找不到输入框").toBeGreaterThan(-1);
    expect(panel, "面板被放到了输入框下面 → 用户要的是上方").toBeLessThan(ta);
  });

  it("没有条目时**整个按钮不渲染**（`any` 为假 ⇒ 不留空壳、不写常驻说明）", () => {
    const panel = between(PANEL_C, "{agentProcs?.any && (", "<textarea ref={inputRef}");
    expect(panel, "渲染条件没绑 `any` → 没有资源时输入框上方会多一条空壳").toContain("agentProcs?.any");
    /* A-1074 迁移：展开态从 `useState(false)` 的局部布尔改为**坞的单值判据**
       （`dock` + `floatDock.toggleDock`，见 tests/gui/float-dock.spec.ts）。
       本条守卫的原意不变 —— "有展开态、点击能展开"；判据换到新家的对应形态。 */
    expect(panel, "没有展开态 → 点击展不开").toContain('toggleDockSlot("procs")');
    /* ⚠️ 必须带 `(e, i)`：折叠摘要行里也有 `agentProcs.entries.map((e) => e.label)` ——
       只断言 `agentProcs.entries.map(` 会被那处喂饱（§8-1 同名字串多产地），实测变异 B4 仍绿。 */
    expect(panel, "没有条目渲染 → 展不开也等于没有").toContain("agentProcs.entries.map((e, i) => (");
  });

  it("渲染层**一个类别判据都不写**：标签/时长/状态词全取自主进程给的条目", () => {
    for (const k of AGENT_PROC_KINDS) {
      expect(PANEL_C, `组件里出现了类别字面量 ${k} → 判据搬到了渲染层，两边会漂移`).not.toContain(`"${k}"`);
    }
    const panel = between(PANEL_C, "{agentProcs?.any && (", "<textarea ref={inputRef}");
    /* ⚠️ 断言必须带闭合的 `</span>`：`${e.kindLabel}` 出现在停止按钮的 title 里，
       只断言 `{e.kindLabel}` 会被那处喂饱（§8-1），实测变异 B6 仍绿。 */
    expect(panel, "类别名没取自主进程（`kindLabel`）").toContain(">{e.kindLabel}</span>");
    expect(panel, "时长没取自主进程（`elapsed`）").toContain("{e.elapsed}");
    expect(panel, "状态词没取自主进程（`status`）").toContain("{e.status}");
    expect(PANEL_C, "渲染层自己格式化时长 → 与主进程两套口径").not.toContain("formatElapsed");
  });

  it("每一条都能**单独停**（用户要的是「Agent 停下时」能看到并能收掉它起的东西）", () => {
    const panel = between(PANEL_C, "{agentProcs?.any && (", "<textarea ref={inputRef}");
    expect(panel, "条目上没有停止入口 → 面板只能看不能收，等于半成品").toContain("stopAgentProc(");
    const cb = between(PANEL_C, "const stopAgentProc = React.useCallback(", "}, []);");
    expect(cb, "停止没走主进程 IPC → 界面自己划掉，与真实状态分家").toContain("api.agentProcs.stop(");
    expect(cb, "停止后没重新取视图 → 面板停在乐观猜测的状态").toContain("api.agentProcs.list()");
  });

  it("订阅广播刷新，**不轮询**（这类信息的价值就在「我现在看到的就是真的」）", () => {
    const eff = between(PANEL_C, "if (!api?.agentProcs?.list) { return; }", "}, [sessionId]);");
    expect(eff, "没订阅广播 → 起了新服务面板不会自己更新").toContain("onChanged(load)");
    expect(eff, "用了轮询 —— 本项目明确要求事件驱动").not.toContain("setInterval");
  });

  it("主进程 list 是**现算**（每次从活真源派生，不维护注册表）", () => {
    /* ⚠️ 必须**限定在 list 处理器体内**断言：同一句 `buildAgentProcView(await collectAgentProcSources(), …)`
       在 stop 处理器（取剩余条数）里也有 —— 全局 toContain 会被那一处喂饱（§8-1），实测变异 B14 仍绿。 */
    const listBody = between(
      MAIN_C,
      'handleTrusted<void>("slime:agentprocs:list"',
      'handleTrusted<AgentProcsStopRequest>("slime:agentprocs:stop"',
    );
    expect(listBody, "list 没走 buildAgentProcView 现算 → 又回到「忘了注销就永驻」的老路")
      .toContain("buildAgentProcView(await collectAgentProcSources(), Date.now())");
  });

  it("主进程 stop **先校验再执行**：非法请求拒绝并给原因（不许静默什么都不做）", () => {
    const stopBody = between(
      MAIN_C,
      'handleTrusted<AgentProcsStopRequest>("slime:agentprocs:stop"',
      'handleTrusted<void>("slime:screen:info"',
    );
    expect(stopBody, "没走 planAgentProcStop 校验 → 手改的 IPC 参数会走到不存在的分支").toContain("planAgentProcStop(");
    // 邻位断言：校验结果必须紧跟一个"不合法就返回失败"的分支（否则校验了也不用）
    expect(stopBody, "校验了却不据此拒绝 → 等于没校验")
      .toMatch(/const plan = planAgentProcStop\([\s\S]{0,200}?if \(!plan\.ok\) \{ return \{ ok: false/);
    // 按动作分派（不是自己 switch kind）
    expect(stopBody, "没有按 plan.action 分派").toContain('plan.action === "dispose-screen-host"');
  });

  it("取数只取三类真源，且**不含应用自身服务**（关掉它们等于把应用拆了）", () => {
    const src = between(MAIN_C, "async function collectAgentProcSources()", "function broadcastAgentProcs()");
    expect(src, "没取图形控制常驻宿主").toContain("desktopBackend.residentHost?.()");
    expect(src, "没取本地服务").toContain("httpServer.list()");
    expect(src, "没取后台子代理").toContain("subagentsRef?.list()");
    for (const forbidden of ["llama", "python-backend", "mcp", "silam"]) {
      expect(src, `取数里出现了应用自身服务（${forbidden}）→ 用户会以为关掉只是停个任务`).not.toContain(forbidden);
    }
  });

  it("回合结束（含被用户停下）就广播 —— 正是用户说的「Agent 停下时」", () => {
    // 邻位：清待办之后紧跟广播（同一段 finally 收口）
    expect(MAIN_C, "回合结束没广播 → 用户停下后看到的是上一帧的旧列表")
      .toMatch(/clearTodosOnTurnEnd\(input\.sessionId\);[\s\S]{0,600}?broadcastAgentProcs\(\);/);
  });

  it("三处接线用同一串通道名（两端都不用共享常量 ⇒ 一边打错就是静默失效）", () => {
    for (const ch of ["slime:agentprocs:list", "slime:agentprocs:stop", "slime:agentprocs:changed"]) {
      expect(MAIN_C, `主进程缺通道 ${ch}`).toContain(ch);
      expect(PRELOAD_C, `preload 缺通道 ${ch}（打错一个字母 = 静默失效，且 tsc 不会报）`).toContain(ch);
    }
  });
});
