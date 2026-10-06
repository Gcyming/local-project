import type { PluginContribution, PluginManifest } from "./manifest.js";
import { parsePluginManifest } from "./manifest.js";

export interface BuiltinPluginGroup {
  name: string;
  description: string;
  contributions: PluginContribution[];
  tools?: string[];
  modules?: string[];
  unloadable: false;
}

export const BUILTIN_PLUGIN_VERSION = "1.0.0";

export const BUILTIN_PLUGIN_GROUPS: BuiltinPluginGroup[] = [
  {
    name: "subagent",
    description: "需要把一段独立子任务交给另一个代理并行去做时；需要回收子代理产出时。",
    contributions: ["tools"],
    tools: ["delegate_subagent", "subagent_result"],
    modules: [
      "core-ts/src/tools/builtin.ts",
      "core-ts/src/services/subagent.ts",
      "core-ts/src/services/subagentCatalog.ts",
    ],
    unloadable: false,
  },
  {
    name: "file-io",
    description: "需要读取、列出、写入或删除工作区文件时。",
    contributions: ["tools"],
    tools: ["file_read", "file_list", "file_write", "file_delete"],
    modules: ["core-ts/src/tools/builtin.ts", "core-ts/src/services/file_undo.ts"],
    unloadable: false,
  },
  {
    name: "doc-authoring",
    description: "需要产出结构化文档（docx / md / html 等）给用户下载时。",
    contributions: ["tools"],
    tools: ["docs_create"],
    modules: ["core-ts/src/tools/builtin.ts", "core-ts/src/office/docWrite.ts"],
    unloadable: false,
  },
  {
    name: "shell-exec",
    description: "需要执行终端命令，或在改动后做语法与类型检查时。",
    contributions: ["tools"],
    tools: ["terminal_run", "code_check"],
    modules: ["core-ts/src/tools/builtin.ts", "core-ts/src/terminal/profiles.ts", "core-ts/src/terminal/ansi.ts"],
    unloadable: false,
  },
  {
    name: "web-access",
    description: "需要抓取某个网址的正文，或联网检索资料时。",
    contributions: ["tools"],
    tools: ["web_fetch", "web_search"],
    modules: [
      "core-ts/src/tools/builtin.ts",
      "core-ts/src/websearch/engine.ts",
      "core-ts/src/websearch/crawler.ts",
      "core-ts/src/search/onlineSearch.ts",
    ],
    unloadable: false,
  },
  {
    name: "user-interaction",
    description: "需求有歧义、需要用户拍板或补充信息时。",
    contributions: ["tools"],
    tools: ["ask_user"],
    modules: ["core-ts/src/tools/builtin.ts", "core-ts/src/services/steerBus.ts"],
    unloadable: false,
  },
  {
    name: "planning",
    description: "任务需要分步骤推进、要给用户看进度或维护待办时。",
    contributions: ["tools"],
    tools: ["plan_create", "plan_update", "todo_write"],
    modules: [
      "core-ts/src/tools/builtin.ts",
      "core-ts/src/planning/plan.ts",
      "core-ts/src/services/todoStore.ts",
      "core-ts/src/services/todoLifecycle.ts",
    ],
    unloadable: false,
  },
  {
    name: "memory",
    description: "需要把事实写进长期记忆、按关键词或语义检索、或召回与遗忘过时记忆时。",
    contributions: ["tools"],
    tools: ["memory_insert", "memory_search", "memory_forget", "memory_recall", "memory_write"],
    modules: [
      "core-ts/src/tools/builtin.ts",
      "core-ts/src/memory/store.ts",
      "core-ts/src/memory/three_layer.ts",
      "core-ts/src/memory/retrieve.ts",
      "core-ts/src/memory/recall_gate.ts",
      "core-ts/src/memory/global.ts",
      "core-ts/src/memory/knowledge.ts",
      "core-ts/src/memory/similarity.ts",
      "core-ts/src/memory/fulltext.ts",
      "core-ts/src/memory/embed_cache.ts",
    ],
    unloadable: false,
  },
  {
    name: "android-device",
    description: "需要通过 adb 控制安卓设备（截图、安装、推包、重启等）时。",
    contributions: ["tools"],
    tools: [
      "adb_setup",
      "adb_devices",
      "adb_shell",
      "adb_install",
      "adb_screencap",
      "adb_connect",
      "adb_push",
      "adb_pull",
      "adb_uninstall",
      "adb_reboot",
    ],
    modules: ["core-ts/src/tools/builtin.ts", "core-ts/src/screen/backends/android.ts"],
    unloadable: false,
  },
  {
    name: "http-service",
    description: "需要把工作区内容临时对外提供 HTTP 服务、或管理已启动的本地服务时。",
    contributions: ["tools"],
    tools: ["http_serve", "http_stop", "http_list", "http_create_app"],
    modules: ["core-ts/src/tools/builtin.ts"],
    unloadable: false,
  },
  {
    name: "sidebar",
    description: "需要在应用侧边栏里打开终端、文件浏览器或挂载自定义面板时。",
    contributions: ["tools"],
    tools: ["sidebar_open_terminal", "sidebar_open_files", "sidebar_mount"],
    modules: ["core-ts/src/tools/builtin.ts", "core-ts/src/sidebarOpen.ts", "core-ts/src/sidebarMount.ts"],
    unloadable: false,
  },
  {
    name: "screen-control",
    description: "需要读取屏幕内容（信息、截图、UI 树）、点击输入、或管理窗口焦点时。",
    contributions: ["tools"],
    tools: [
      "screen_info",
      "screen_capture",
      "screen_ui_dump",
      "screen_action",
      "screen_windows",
      "screen_focus",
    ],
    modules: [
      "core-ts/src/tools/builtin.ts",
      "core-ts/src/screen/controller.ts",
      "core-ts/src/screen/arbiter.ts",
      "core-ts/src/screen/optimize.ts",
      "core-ts/src/screen/backends/desktop.ts",
      "core-ts/src/screen/backends/android.ts",
    ],
    unloadable: false,
  },
  {
    name: "browser",
    description: "需要驱动真实浏览器（开页、读正文、点击、填表、截图、等待）时。",
    contributions: ["tools"],
    tools: [
      "browser_tabs",
      "browser_open_tab",
      "browser_close_tab",
      "browser_navigate",
      "browser_read",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_scroll",
      "browser_drag",
      "browser_screenshot",
      "browser_wait",
    ],
    modules: ["core-ts/src/tools/browser.ts"],
    unloadable: false,
  },
  {
    name: "skill-instructions",
    description: "需要按需检索并加载某个技能（SKILL.md）的完整指导正文时。",
    contributions: ["tools", "instructions"],
    tools: ["skill_search", "skill_lookup"],
    modules: ["core-ts/src/skills.ts", "core-ts/src/services/agentTools.ts"],
    unloadable: false,
  },
  {
    name: "doc-parsing",
    description: "用户给了 docx/xlsx/pptx/pdf/zip/OLE 老格式附件，需要读出正文时。",
    contributions: ["tools"],
    modules: [
      "core-ts/src/doc_text.ts",
      "core-ts/src/pdf_text.ts",
      "core-ts/src/zip.ts",
      "core-ts/src/cfb.ts",
      "core-ts/src/text/encoding.ts",
    ],
    unloadable: false,
  },
  {
    name: "office-render",
    description: "需要保真渲染 Office 文档、或判断某个文件该不该走 LibreOffice 转换时。",
    contributions: ["tools"],
    modules: [
      "core-ts/src/office/docWrite.ts",
      "core-ts/src/office/fileKinds.ts",
      "core-ts/src/office/libreoffice.ts",
      "core-ts/src/office/renderPlan.ts",
    ],
    unloadable: false,
  },
  {
    name: "online-search",
    description: "需要联网做多源检索并交叉验证，而不只是一次网页抓取时。",
    contributions: ["tools"],
    modules: [
      "core-ts/src/search/onlineSearch.ts",
      "core-ts/src/websearch/engine.ts",
      "core-ts/src/websearch/crawler.ts",
    ],
    unloadable: false,
  },
  {
    name: "mind",
    description: "需要按情绪与行为状态调整语气、或挂载心智钩子影响生成时。",
    contributions: ["prompt"],
    modules: ["core-ts/src/mind/emotion.ts", "core-ts/src/mind/behavior.ts", "core-ts/src/mind/hooks.ts"],
    unloadable: false,
  },
  {
    name: "silam",
    description: "需要 SILAM 心智内核参与推理、或维护长期人格状态时。",
    contributions: ["prompt"],
    modules: ["core-ts/src/services/silam_brain.ts", "core-ts/src/services/engine.ts"],
    unloadable: false,
  },
  {
    name: "local-model",
    description: "需要拉起本地模型服务、读取 GGUF 元信息、或做模型能力自省时。",
    contributions: ["tools"],
    modules: [
      "core-ts/src/model_server.ts",
      "core-ts/src/local_models.ts",
      "core-ts/src/local_server_io.ts",
      "core-ts/src/gguf_meta.ts",
      "core-ts/src/model_introspect.ts",
    ],
    unloadable: false,
  },
  {
    name: "sandbox",
    description: "涉及受限路径、受保护目录或写入拦截时，需要先过沙箱判定。",
    contributions: ["tools"],
    modules: [
      "core-ts/src/sandbox.ts",
      "core-ts/src/tools/policy.ts",
      "core-ts/src/tools/grant.ts",
      "core-ts/src/tools/hard_rules.ts",
    ],
    unloadable: false,
  },
  {
    name: "terminal-shell",
    description: "需要按 profile 执行 shell 命令并渲染 ANSI 输出时。",
    contributions: ["tools"],
    modules: ["core-ts/src/terminal/ansi.ts", "core-ts/src/terminal/profiles.ts"],
    unloadable: false,
  },
  {
    name: "social",
    description: "需要把消息投递到社交渠道（如企业微信）时。",
    contributions: ["tools"],
    modules: ["core-ts/src/social/wecom.ts", "core-ts/src/services/social.ts"],
    unloadable: false,
  },
  {
    name: "multi-agent",
    description: "需要多个代理之间发消息、群聊协作、或头脑风暴时。",
    contributions: ["tools"],
    modules: [
      "core-ts/src/a2a.ts",
      "core-ts/src/services/grouptalk.ts",
      "core-ts/src/services/grouptalkTranscript.ts",
      "core-ts/src/services/brainstorm.ts",
      "core-ts/src/services/agentProcs.ts",
    ],
    unloadable: false,
  },
  {
    name: "guardrails",
    description: "需要标记事实性主张、过滤不安全输出、或在 diff 上做增量标记时。",
    contributions: ["prompt"],
    modules: ["core-ts/src/claims.ts", "core-ts/src/filter.ts", "core-ts/src/diff_marker.ts"],
    unloadable: false,
  },
  {
    name: "encryption",
    description: "需要加密存储用户密钥或敏感配置时。",
    contributions: ["tools"],
    modules: ["core-ts/src/encryption.ts"],
    unloadable: false,
  },
  {
    name: "observability",
    description: "需要记录一次调用的链路轨迹以便排查问题时。",
    contributions: ["tools"],
    modules: [
      "core-ts/src/observability/trace.ts",
      "core-ts/src/services/usage.ts",
      "core-ts/src/services/stats.ts",
    ],
    unloadable: false,
  },
  {
    name: "model-routing",
    description: "需要在多个模型之间按策略路由、或统一发起 LLM 请求时。",
    contributions: ["tools"],
    modules: [
      "core-ts/src/router.ts",
      "core-ts/src/llm/client.ts",
      "core-ts/src/llm/maxTokens.ts",
      "core-ts/src/llm/rpmLimiter.ts",
      "core-ts/src/llm/upstreamNotice.ts",
      "core-ts/src/llm/userReminder.ts",
      "core-ts/src/services/fallbackPool.ts",
    ],
    unloadable: false,
  },
  {
    name: "mcp-bridge",
    description: "需要接入外部 MCP 服务器以获得其提供的工具时。MCP 是工具的一种来源，不是贡献类型。",
    contributions: ["tools"],
    modules: ["core-ts/src/mcp.ts"],
    unloadable: false,
  },
  {
    name: "plugin-management",
    description: "创造模式下写完插件文件后，需要确认它是否真的被装载时（文件存在不等于装载成功）。",
    contributions: ["tools"],
    tools: ["plugin_status"],
    modules: ["core-ts/src/tools/builtin.ts", "core-ts/src/plugin/host.ts"],
    unloadable: false,
  },
];

export const BUILTIN_TOOL_NAMES: string[] = BUILTIN_PLUGIN_GROUPS.flatMap((g) => g.tools ?? []);

export function builtinPluginManifests(): PluginManifest[] {
  const manifests: PluginManifest[] = [];
  const failures: string[] = [];
  for (const group of BUILTIN_PLUGIN_GROUPS) {
    const parsed = parsePluginManifest({
      name: group.name,
      version: BUILTIN_PLUGIN_VERSION,
      description: group.description,
      origin: "builtin",
      provides: group.contributions,
    });
    if (parsed.ok) {
      manifests.push(parsed.manifest);
    } else {
      failures.push(`${group.name}: ${parsed.errors.join("；")}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`内置插件清单非法：${failures.join(" | ")}`);
  }
  return manifests;
}

export interface BuiltinCoverageReport {
  covered: string[];
  missing: string[];
  extra: string[];
}

export function auditBuiltinCoverage(registeredToolNames: string[]): BuiltinCoverageReport {
  const declared = BUILTIN_TOOL_NAMES;
  const declaredSet = new Set(declared);
  const actual = registeredToolNames.filter((n) => !n.startsWith("mcp_"));

  const covered: string[] = [];
  const missing: string[] = [];
  for (const name of declared) {
    if (actual.includes(name)) {
      covered.push(name);
    } else {
      missing.push(name);
    }
  }

  const extra = actual.filter((n) => !declaredSet.has(n));

  const dupes = declared.filter((n, i) => declared.indexOf(n) !== i);
  for (const d of dupes) {
    missing.push(`重复登记:${d}`);
  }

  return { covered, missing, extra };
}