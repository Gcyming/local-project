# SubAgentManager v2.1 — GUI 装配层集成指南

> 目标文件：`gui/src/main/index.ts`
> 前置：已用本包 `subagent.ts` 覆盖 `core-ts/src/services/subagent.ts`。
> 说明：以下改动**全部为可选叠加**——不改也能编译运行（公开 API 完全向后兼容），
> 但改完后子代理的「取消/超时/模型路由/结构化结果/钩子」才在 GUI 链路真正生效。

---

## 1. Runner 升级：取消信号 + 模型路由（锚点：现 `const subagents = new SubAgentManager(async (def) => { ... }, { concurrency: 3 });`，约 L410–428）

将 runner 替换为如下版本（三处增强：ctx.signal 中断竞速、def.model 模型路由、结构化结果一并落盘）：

```ts
      // Phase 3 子代理管理器：后台独立上下文并行执行（Claude Code subagent 对标），结果落盘 subagent-*.md
      const subagents = new SubAgentManager(async (def, ctx) => {
        const ag = def.agentId
          ? (await agentRegistry?.findAgent(def.agentId))
          : undefined;
        let target = ag ?? agentRegistry?.loadedAgents[0];
        if (!target) { throw new Error(`子代理「${def.name}」找不到可执行 Agent`); }
        // v2 模型路由：def.model 为路由语法（api:<key>[:<model>] / local:<id> / inherit）时覆盖目标模型
        if (def.model && /^(api:|local:|inherit)/.test(def.model.trim())) {
          target = { ...target, model_choice: def.model.trim() };
        }
        if (!engine) { throw new Error("引擎未就绪"); }
        // v2 取消/超时：signal 竞速——即使 engine.stream 内部不感知 signal，runner 也会在 abort 时立即中断返回
        const runStream = async (): Promise<string> => {
          let reply = "";
          for await (const ev of engine.stream({ agent: target, message: def.task, history: [], systemPrompt: system })) {
            if (ev.type === "done") { reply = ev.reply ?? ""; }
          }
          return reply;
        };
        const reply = await new Promise<string>((resolve, reject) => {
          const sig = ctx?.signal;
          if (!sig) { runStream().then(resolve, reject); return; }
          if (sig.aborted) { reject(new Error("aborted")); return; }
          const onAbort = (): void => reject(new Error("aborted"));
          sig.addEventListener("abort", onAbort, { once: true });
          runStream().then(
            (r) => { sig.removeEventListener("abort", onAbort); resolve(r); },
            (e) => { sig.removeEventListener("abort", onAbort); reject(e); },
          );
        });
        const dir = join(INSTALL_ROOT, "data", "generated");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(dir, `subagent-${def.name}-${stamp}.md`), reply, "utf8");
        return reply;
      }, {
        concurrency: 3,
        // v2 生命周期钩子（观测/审计注入点；按需要替换为真实埋点）
        hooks: {
          onStart: (run) => console.log(`[subagent] 开始 ${run.name} (${run.id})`),
          onComplete: (run) => console.log(`[subagent] 完成 ${run.name}，${run.structured ? "含结构化结果" : "文本结果"}`),
          onError: (run) => console.warn(`[subagent] ${run.status} ${run.name}: ${run.error ?? ""}`),
        },
      });
```

> `maxTurns` 说明：GUI runner 目前是「单轮 stream」语义；多轮预算需要 runner 内部做轮次循环
> （参考 `core-ts/src/executor.ts` 的 `MAX_ROUNDS` 模式）。如暂不需要多轮子代理，可忽略该字段。

## 2. IPC：spawn 透传新字段 + 新增 cancel（锚点：现 `ipcMain.handle("slime:resident:subagent:spawn", ...)`，约 L485–489）

```ts
      ipcMain.handle("slime:resident:subagent:spawn", (_e, p: {
        name?: string; task?: string; systemPrompt?: string; agentId?: string;
        model?: string; timeoutMs?: number; outputSchema?: boolean; toolsOnly?: string[];
      }) => {
        if (!p?.name || !p?.task) { return { ok: false, error: "name/task 必填" }; }
        const run = subagents.spawn({
          name: p.name, task: p.task, systemPrompt: p.systemPrompt, agentId: p.agentId,
          model: p.model, timeoutMs: p.timeoutMs, outputSchema: p.outputSchema, toolsOnly: p.toolsOnly,
        });
        return { ok: true, run };
      });
      // v2 取消运行中/排队中的子代理
      ipcMain.handle("slime:resident:subagent:cancel", (_e, p: { id?: string }) => ({
        ok: !!p?.id && subagents.cancel(p.id!),
      }));
```

## 3.（可选）声明式定义 + 自动委派

在 `subagents` 创建后注册专家定义，渲染层即可用 `subagents.delegate(task)` 让系统按描述自动选人：

```ts
      subagents.register({
        name: "代码审查员",
        description: "审查代码质量、发现潜在 bug、静态分析与改进建议",
        systemPrompt: "你是资深代码审查专家，输出问题清单与修复建议。",
        model: "inherit",        // 简单审查可改指便宜模型路由，压缩 token 成本
        timeoutMs: 120_000,
        outputSchema: true,
      });
      // 之后：const run = subagents.delegate("帮我审查 auth 模块的代码"); // 自动命中「代码审查员」
```

---

## 4. 验证步骤

```bash
cd D:\pilot project
# 类型检查（strict）
core-ts\node_modules\.bin\tsc -p core-ts\tsconfig.json --noEmit
# 子代理回归（v1 契约 + v2 新能力，共 12 例）
pnpm vitest run tests/core-ts/subagent.spec.ts
# 全量回归
py qa.py
```
