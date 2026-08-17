# Reasoning 功能实现状态核对

**核对时间**: 2026-08-15（A-014 文档对齐：本文件由历史计划文档改写为现状核对）
**结论**: ✅ 计划功能已全部落地，测试已补齐

---

## 计划项 → 现状对照

| 计划项 | 现状 | 位置 |
|---|---|---|
| `mode` 字段（build/plan） | ✅ 已实现（plan 逻辑仍后置，仅存储） | `core/agent.py` `__init__/to_dict/from_dict/split` 三处同步 + 继承 |
| `reasoning_effort` 字段 | ✅ 已实现（none/low/medium/high） | `core/agent.py` |
| `show_thinking` 字段（on/off/auto） | ✅ 已实现 | `core/agent.py` |
| 统一 reasoning 参数注入 | ✅ `_build_reasoning_params(agent, cfg)`（早期名 `_inject_reasoning_params`，已改名） | `core/llm.py` |
| 3 处 payload 注入统一 | ✅ 均为 `payload.update(_build_reasoning_params(agent, cfg))` | `call_api_provider` / `call_api_provider_with_meta` / `call_api_provider_stream` |
| `_compose_system_prompt()` 消除重复 | ✅ 已实现（L1 身份铁律 + L2 行为模式，动态记忆走 message 层） | `core/llm.py` |
| 流式过滤（off 丢弃 / on 透传 / auto 仅 plan） | ✅ `_should_yield_reasoning(agent)` | `core/llm.py`，主循环 + 工具轮循环两处接入 |
| `/mode` `/think` `/thinking` 命令 | ✅ 三个命令均已添加 | `slime_cli.py` `_CMD_SPECS` |
| reasoning 测试用例 | ✅ `TestReasoningExtraction`(2) + `TestReasoningParams`(6) | `tests/test_tools.py` |

## 语义约定

- **effort=none 零注入**（默认，最安全）；provider `reasoning_enabled=false` 整体关闭（严格网关兜底）
- **anthropic 风格**：`{"thinking": {"type": "enabled", "budget_tokens": N}}`（low 2048 / medium 8192 / high 16384）；openai 风格：`{"reasoning_effort": effort}`
- **思考提取**：`reasoning_content → reasoning → thinking` 优先级，delta + chunk 顶层兜底（覆盖 DeepSeek/Qwen/Kimi/GLM/OpenAI/Grok/Gemini/Anthropic）
- **CLI 展示**：正文前思考 → Panel("思考")；正文后才到达的思考 → 结尾 Panel("后续思考")（A-009，不再交错破坏布局）
- **身份过滤**：reasoning 与正文一致经受 `_StreamFilter` 跨 chunk 过滤（A-010）
- **非流式路径**（/chat、社交 webhook）：不展示思考（v1 明确跳过）

## 验证清单

- [x] `py qa.py` 全绿（compileall + run_tests.py + pytest 双入口）
- [x] effort∈{low,medium,high} 注入正确；none 零注入；reasoning_enabled=false 关闭（TestReasoningParams）
- [x] split 继承 effort/show_thinking/mode（TestReasoningParams）
- [x] show_thinking on/off/auto 三态透传判定（TestReasoningParams）
- [x] Agent 字段序列化/反序列化（test_smoke TestAgentPhase2）
- [x] 跨 chunk 思考/正文过滤不绕过身份铁律（TestStreamFilter）

> 历史遗留说明：`mode=plan` 的写权限拦截逻辑仍后置（Agent.mode 仅存储），
> 与"思考展示 auto=仅 plan"联动已实现；plan 模式的完整行为约束登记在
> `docs/REVIEW_AGENT.md` P3 待办。
