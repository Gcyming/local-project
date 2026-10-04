











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
  planAgentProcStop,
  type AgentProcSources,
} from "../../core-ts/src/services/agentProcs.js";


const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("A-1069-A 范围：只有「Agent 启动的」才进面板（应用服务明确排除）", () => {
  it("两类就是 Agent 工具能起、且停下后仍然活着的两类（**脚本宿主 + 端口**）", () => {
    expect([...AGENT_PROC_KINDS]).toEqual(["screen-host", "http-server"]);
  });

  it("⚠️ **子代理不在这个面板里**（用户 2026-09-26：「只监视 Agent 运行的脚本、端口」）", () => {
    





    const kinds = AGENT_PROC_KINDS as readonly string[];
    expect(kinds, "子代理又回到了后台资源面板（用户明确要求移出）").not.toContain("subagent");
    expect(Object.keys(AGENT_PROC_KIND_LABELS), "标签表里还有子代理").not.toContain("subagent");
    expect(Object.keys(AGENT_PROC_STOP_ACTIONS), "停止动作表里还有子代理").not.toContain("subagent");
    expect(isAgentStartedKind("subagent"), "isAgentStartedKind 仍把子代理当成后台资源").toBe(false);
    
    const v = buildAgentProcView(
      { subagents: [{ id: "a1", name: "研究员", status: "running" }] } as unknown as AgentProcSources,
      1_000,
    );
    expect(v.count, "子代理被算成了后台资源条目").toBe(0);
    expect(v.any).toBe(false);
  });

  it("每一类都有中文名与停止动作（新增类别漏配这两样 = 面板上出现无法停止的条目）", () => {
    for (const k of AGENT_PROC_KINDS) {
      expect(AGENT_PROC_KIND_LABELS[k], `${k} 缺中文名`).toBeTruthy();
      expect(AGENT_PROC_STOP_ACTIONS[k], `${k} 缺停止动作`).toBeTruthy();
    }
    expect(Object.keys(AGENT_PROC_KIND_LABELS).sort()).toEqual([...AGENT_PROC_KINDS].sort());
    expect(Object.keys(AGENT_PROC_STOP_ACTIONS).sort()).toEqual([...AGENT_PROC_KINDS].sort());
  });

  it("isAgentStartedKind：认这两类，认不出应用服务名（它们根本不该进 sources）", () => {
    for (const k of AGENT_PROC_KINDS) { expect(isAgentStartedKind(k)).toBe(true); }
    for (const bad of ["llama-server", "python-backend", "mcp", "silam", "electron", "subagent", "sub-agent", "", "http-server "]) {
      expect(isAgentStartedKind(bad), `${bad || "(空串)"} 不该被认成 Agent 启动的资源`).toBe(false);
    }
  });

  it("空真源 → 视图为空（`any=false` ⇒ 组件不渲染按钮，不留空壳）", () => {
    const v = buildAgentProcView({}, 1_000);
    expect(v.count).toBe(0);
    expect(v.any).toBe(false);
    expect(v.entries).toEqual([]);
  });

  it("两类齐全时才两条 —— 且**只**来自传进来的真源（没有第三条来源）", () => {
    const v = buildAgentProcView({
      screenHost: { pid: 4242, startedAt: 0 },
      httpServers: [{ id: "s1", port: 8080, dir: "D:/x", startedAt: 0 }],
    }, 5_000);
    expect(v.count).toBe(2);
    expect(v.entries.map((e) => e.kind)).toEqual(["screen-host", "http-server"]);
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

describe("A-1069-C2 范围判据（`origin`）：哪些服务**不该**出现在「Agent 后台资源」面板", () => {
  const svc = (origin?: "agent" | "restored" | "builtin") => ({
    id: "svc-1", port: 8081, dir: "C:/Users/x/AppData/slime-gui/slime-search/page", startedAt: 0, origin,
  });

  it("缺省 / `agent` → 进面板（本次运行途中由 Agent 起的，正是用户要看的）", () => {
    for (const origin of [undefined, "agent" as const]) {
      const v = buildAgentProcView({ httpServers: [svc(origin)] }, 1);
      expect(v.count, `origin=${String(origin)} 该进来却没进来`).toBe(1);
      expect(v.entries[0].label).toContain("8081");
    }
  });

  



  it("`restored` → **不进**面板（应用启动时按上次清单重建的，不是 Agent 运行途中打开的）", () => {
    const v = buildAgentProcView({ httpServers: [svc("restored")] }, 1);
    expect(v.count, "启动时重建的服务又出现在面板里了（用户原话：「我要的是 Agent 运行途中打开的」）").toBe(0);
  });

  

  it("`builtin` → **不进**面板（slime 自身功能托管的页面，如右栏搜索页）", () => {
    const v = buildAgentProcView({ httpServers: [svc("builtin")] }, 1);
    expect(v.count, "slime 自己的页面又被当成 Agent 后台资源了").toBe(0);
  });

  it("三类混在一起时只留 `agent` 那条（过滤按条生效，不是「有一条不是 agent 就整批不显示」）", () => {
    const v = buildAgentProcView({
      httpServers: [svc("restored"), svc("builtin"), { ...svc("agent"), id: "mine", dir: "D:/proj/dist" }],
    }, 1);
    expect(v.count).toBe(1);
    expect(v.entries[0].id).toBe("mine");
  });

  


  it("未知 origin 取值 → 不进面板（范围判据是白名单：只有明确的 `agent` 才进）", () => {
    const v = buildAgentProcView({
      httpServers: [{ ...svc(), origin: "something-new" as unknown as "agent" }],
    }, 1);
    expect(v.count, "未知来源被默认放进面板了 —— 新增类别会静默泄漏到用户眼前").toBe(0);
  });
});

describe("A-1069-D 范围收窄（用户 2026-09-26）：子代理**不再是**后台资源条目", () => {
  





  it("无论子代理什么状态，都不产出后台资源条目（running 也不行）", () => {
    for (const status of ["running", "pending", "done", "fail", "timeout", "cancelled"]) {
      const v = buildAgentProcView(
        { subagents: [{ id: "x", name: "研究员", status, startedAt: 0, task: "调研" }] } as unknown as AgentProcSources,
        1_000,
      );
      expect(v.count, `子代理（${status}）又被算成后台资源了`).toBe(0);
    }
  });

  it("子代理与真实的端口/宿主**混在一起**时也只留后两者（不会被顺手带出来）", () => {
    const v = buildAgentProcView({
      screenHost: { pid: 1, startedAt: 0 },
      httpServers: [{ id: "s", port: 80, dir: "D:/s", startedAt: 0 }],
      subagents: [{ id: "a", name: "子代理", status: "running", startedAt: 0 }],
    } as unknown as AgentProcSources, 1_000);
    expect(v.entries.map((e) => e.kind)).toEqual(["screen-host", "http-server"]);
    expect(v.count).toBe(2);
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
      httpServers: [
        { id: "late", port: 81, dir: "D:/l", startedAt: 5_000 },
        { id: "early", port: 80, dir: "D:/e", startedAt: 1_000 },
      ],
      screenHost: { startedAt: 9_999 },
    }, 10_000);
    expect(v.entries.map((e) => e.id)).toEqual(["", "early", "late"]);
  });
});

describe("A-1069-F 停止请求：合法才给动作，非法必须拒绝（不许静默什么都不做）", () => {
  it("两类各自的动作", () => {
    expect(planAgentProcStop({ kind: "screen-host" })).toEqual({ ok: true, action: "dispose-screen-host", id: "" });
    expect(planAgentProcStop({ kind: "http-server", id: "svc-1" }))
      .toEqual({ ok: true, action: "stop-http-server", id: "svc-1" });
  });

  it("⚠️ 子代理的停止请求**必须被拒绝**（它已不是本面板的资源 —— 放行就等于两处都能停）", () => {
    


    expect(planAgentProcStop({ kind: "subagent", id: "run-9" }).ok).toBe(false);
    expect(planAgentProcStop({ kind: "subagent" }).ok).toBe(false);
  });

  it("未知类别 → 拒绝（否则主进程会走到不存在的分支，而界面已乐观划掉）", () => {
    for (const k of ["llama-server", "python-backend", "mcp", "", undefined]) {
      const r = planAgentProcStop({ kind: k as string });
      expect(r.ok, `${String(k)} 应被拒绝`).toBe(false);
    }
  });

  it("未知类别**即使带了 id** 也拒绝（带 id 会把 `AGENT_PROC_STOP_ACTIONS[kind]` 取成 undefined）", () => {
    

    for (const k of ["llama-server", "python-backend", "mcp", "screenhost", "screen-host "]) {
      expect(planAgentProcStop({ kind: k, id: "x" }).ok, `${k} 带 id 也不该通过`).toBe(false);
    }
  });

  it("http-server 缺 id → 拒绝（停哪个无从谈起）", () => {
    for (const kind of ["http-server"] as const) {
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
    

    expect(v2.count).toBe(1);
    expect(v2.entries, "两次派生共享了同一个数组实例 → 一处 pop 会污染另一处").toHaveLength(1);
    expect(v1.entries, "返回的是同一个数组引用").not.toBe(v2.entries);
  });
});















describe("A-1069-H 接线：面板在输入栏上方 / 判据不在渲染层 / 主进程现算+先校验", () => {
  const PANEL = read("gui/src/renderer/pages/ChatPanel.tsx");
  const PANEL_C = strip(PANEL);
  const MAIN_C = strip(read("gui/src/main/index.ts"));
  const PRELOAD_C = strip(read("gui/src/preload/index.ts"));

  

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
    


    expect(panel, "没有展开态 → 点击展不开").toContain('toggleDockSlot("procs")');
    

    expect(panel, "没有条目渲染 → 展不开也等于没有").toContain("agentProcs.entries.map((e, i) => (");
  });

  it("渲染层**一个类别判据都不写**：标签/时长/状态词全取自主进程给的条目", () => {
    for (const k of AGENT_PROC_KINDS) {
      expect(PANEL_C, `组件里出现了类别字面量 ${k} → 判据搬到了渲染层，两边会漂移`).not.toContain(`"${k}"`);
    }
    const panel = between(PANEL_C, "{agentProcs?.any && (", "<textarea ref={inputRef}");
    

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
    
    expect(stopBody, "校验了却不据此拒绝 → 等于没校验")
      .toMatch(/const plan = planAgentProcStop\([\s\S]{0,200}?if \(!plan\.ok\) \{ return \{ ok: false/);
    
    expect(stopBody, "没有按 plan.action 分派").toContain('case "dispose-screen-host":');
    expect(stopBody, "http-server 那一路没有按 plan.action 分派").toContain('case "stop-http-server":');
  });

  it("取数只取两类真源，且**不含应用自身服务 / 不含子代理**", () => {
    const src = between(MAIN_C, "async function collectAgentProcSources()", "function broadcastAgentProcs()");
    expect(src, "没取图形控制常驻宿主").toContain("desktopBackend.residentHost?.()");
    expect(src, "没取本地服务").toContain("httpServer.list()");
    
    expect(src, "取数里又出现了子代理（用户明确要求移出本面板）").not.toContain("subagents");
    for (const forbidden of ["llama", "python-backend", "mcp", "silam"]) {
      expect(src, `取数里出现了应用自身服务（${forbidden}）→ 用户会以为关掉只是停个任务`).not.toContain(forbidden);
    }
  });

  it("回合结束（含被用户停下）就广播 —— 正是用户说的「Agent 停下时」", () => {
    
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
