/**
 * 产物断言：确认 A-980-R26/R27 的功能真的进了构建产物。
 * 覆盖三层：main（通知本体/IPC/落盘路径/待办广播）、preload（API 暴露）、renderer（界面文案与交互）。
 *
 * 为什么断言字符串而不是函数名：renderer 生产构建会压缩改名（esbuild minify），
 * 函数名/标识符不保真；而 IPC 频道名与界面文案是字符串字面量，压缩后仍在。
 * 用法：node scripts/assert-bundle.mjs（在 gui/ 下执行）
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function readAll(dir, exts) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { out.push(...readAll(p, exts)); }
    else if (exts.some((e) => f.endsWith(e))) { out.push(p); }
  }
  return out;
}

const main = readAll("out/main", [".js"]).map((p) => [p, readFileSync(p, "utf8")]);
const preload = readAll("out/preload", [".js"]).map((p) => [p, readFileSync(p, "utf8")]);
const renderer = readAll("out/renderer", [".js", ".css", ".html"]).map((p) => [p, readFileSync(p, "utf8")]);

let fail = 0;
function check(group, files, needle, label) {
  const hit = files.some((pair) => pair[1].includes(needle));
  if (!hit) { fail++; }
  console.log(`${hit ? "OK  " : "MISS"} [${group}] ${label}`);
}

/**
 * 允许一组等价写法任一命中。
 * 为什么需要：可选链 `ctx?.signal` 是否被 esbuild 降级（`ctx==null?void 0:ctx.signal`）
 * 取决于 target 配置，写死单一形态会让断言在"代码没变、只是降级策略变了"时假红。
 */
function checkAny(group, files, needles, label) {
  const hit = files.some((pair) => needles.some((n) => pair[1].includes(n)));
  if (!hit) { fail++; }
  console.log(`${hit ? "OK  " : "MISS"} [${group}] ${label}`);
}

console.log("=== main ===");
for (const ch of ["slime:notify:get", "slime:notify:set", "slime:notify:sound:pick", "slime:notify:sound:clear", "slime:notify:sound:data", "slime:notify:test", "slime:notify:playsound"]) {
  check("main", main, ch, ch);
}
check("main", main, "com.slime.gui", "AUMID 归属");
check("main", main, "notification-sounds", "音频落盘目录");
check("main", main, "notifications.json", "配置文件");

console.log("=== preload ===");
for (const ch of ["slime:notify:get", "slime:notify:set", "slime:notify:sound:pick", "slime:notify:sound:clear", "slime:notify:sound:data", "slime:notify:test", "slime:notify:playsound"]) {
  check("preload", preload, ch, ch);
}
check("preload", preload, "notify", "notify API 命名空间");

console.log("=== renderer ===");
for (const s of ["系统通知", "通知提示音", "上传音频", "发送测试通知", "恢复默认", "试听"]) {
  check("renderer", renderer, s, s);
}
// 播放端在渲染层：必须真的构造 Audio 播放（主进程没有音频能力）
check("renderer", renderer, "new Audio(", "渲染层 Audio 播放器");
// 订阅入口：renderer 通过 window.slimeAPI.notify 拿 API（频道名在 preload，故此处只断言 API 面）
check("renderer", renderer, "slimeAPI", "renderer 侧 slimeAPI 引用");

console.log("=== 待办任务（A-980-R27）===");
// 根因回归：循环必须注入 sessionId —— 断言会话级工具名单真的建起来了
check("main", main, "slime:tasks:todos", "待办广播通道");
check("main", main, "todos_", "会话级待办落盘路径");
check("main", main, "broadcastTodos", "工具轮写入后即时广播");
check("preload", preload, "slime:tasks:todos", "渲染层订阅通道");
check("preload", preload, "slime:sessions:loadTodos", "切会话主动拉取");
// 完成标记样式：动画在 CSS 里，类名必须进产物
check("renderer", renderer, "todo-row", "完成态行样式类");
check("renderer", renderer, "todo-check-path", "对勾画入动画类");
check("renderer", renderer, "todo-check-draw", "画入 keyframes");
check("renderer", renderer, "todo-just-done", "完成瞬间反馈 keyframes");
check("renderer", renderer, "prefers-reduced-motion", "减弱动效适配");
check("renderer", renderer, "进行中", "状态分组标题");
check("renderer", renderer, "全部完成", "全完成徽标");
check("renderer", renderer, "正在加载会话", "会话未就绪空态门闸");
check("renderer", renderer, "收起待办列表", "箭头可访问名（展开/收起）");
check("renderer", renderer, "全部完成", "全完成徽标");

console.log("=== 任务规划收尾（A-980-R29）===");
// 单一真源：主进程不再手搓待办路径，统一走 todoStore
check("main", main, "purgeSessionPlanning", "会话删除时清理 Plan + 待办文件");
check("main", main, "PLAN_STORE_MAX", "planStore 有上限（不再无限驻留）");
check("main", main, "loadTodos 收到空 sessionId，已拒绝", "空 sessionId 拒绝读取");
// 渲染层：Plan 来源标注 + 按会话去重
check("renderer", renderer, "只读镜像", "todo 派生 Plan 的来源标注");
check("renderer", renderer, "结构化计划", "plan_create 真 Plan 的来源标注");


console.log("=== 子代理派发/验收（A-980-R30）===");
// 清单注入：模型必须知道"能问谁"，否则用户勾选的自建子代理永远派不到
check("main", main, "subagentCatalogSegment", "可用子代理清单注入");
check("main", main, "可用子代理", "清单段落标题");
// 深度守卫：子代理不再获得派发/收取能力（防指数级套娃）
check("main", main, "dispatchTools", "子代理深度守卫");
check("renderer", renderer, "委派子代理", "工具卡：委派子代理（修正 delegate 名字不匹配）");
check("renderer", renderer, "收取子代理结果", "工具卡：收取子代理结果");
// 验收包：状态/自评/验收要求必须进产物（这是结果回流的可见证据）
check("renderer", renderer, "超时中断", "超时态不再显示成「排队」");
check("renderer", renderer, "已取消", "取消态徽标");

console.log("=== 子代理超时/记录/实时监测（A-980-R31）===");
// ① 超时 abort 真的生效：装配层把 signal 透传进引擎流（漏传 = 120s 预算跑 332s 的根因）
checkAny("main", main, ["signal: ctx?.signal", "signal: ctx == null ? void 0 : ctx.signal", "ctx==null?void 0:ctx.signal"], "子代理 runner 透传 AbortSignal");
// ①b abort 判定必须在消费完事件之后（先收残稿再判中断，否则最后一次 partial done 被丢）
checkAny("main", main, ["ctx?.signal.aborted", "ctx == null ? void 0 : ctx.signal.aborted", "ctx==null?void 0:ctx.signal.aborted"], "runner 消费事件后再判 aborted");
// ② 运行记录落盘 + 重启可查（此前纯内存 Map → 面板空白、下拉按钮消失）
check("main", main, "subagent-runs.json", "运行记录落盘路径");
check("main", main, "slime:resident:subagent:clear", "清空历史 IPC（main）");
check("preload", preload, "slime:resident:subagent:clear", "清空历史 IPC（preload 真实现）");
// ③ 后台子代理的授权/提问请求在主进程即时处理（渲染层会话过滤必然丢弃 → 白挂 5 分钟）
check("main", main, "无人可交互确认", "后台子代理授权请求即时拒绝并给出原因");
check("renderer", renderer, "中断前已产出", "中断残稿可见（不再 0 字节无记录）");
check("renderer", renderer, "清空历史", "设置页清空历史入口");
// ④ 头像图标库真的进了产物（取一段长路径数据做指纹，压缩不改字符串字面量）
check("renderer", renderer, "M512.255872 25.075462", "子代理头像图标库（icon_1cdszr8as42）已进包");

console.log("=== 定价链路 / 历史成本回填（A-970）===");
// 事故：usage.jsonl 1621 条记录 100% 成本为 0（含 52M tokens 的 deepseek-flash）。
// 根因有三处，逐一在产物里验证修复确实进了包：
// ① 上游探针两阶段：/v1/models 返回 200 但没有 pricing 时，**仍必须**去 /api/pricing 取价
//    （旧实现"命中即 return"→ 定价端点永远执行不到）
check("main", main, "/api/pricing", "阶段 2：网关定价端点");
check("main", main, "/api/ratio_config", "阶段 2：new-api 倍率端点");
check("main", main, "probeUpstreamTwoPhase", "两阶段探测（互不短路）");
// ② 内置价目表覆盖 DeepSeek（此前 regex 漏 deepseek-flash + 美元价被除了一次 7.25）
check("main", main, "deepseek.*pro", "价目表：deepseek pro 档");
check("main", main, "0.0045", "价目表：deepseek flash 缓存命中价（不再除以汇率）");
// ③ 手填价保护：price_source=manual 必须进产物，否则一键刷新会静默抹掉用户手填价
check("main", main, "mergeModelPrice", "手填价保护（合并点）");
check("main", main, "price_source", "定价来源标记");
// ④ 历史成本回填链路：IPC → 取价器 → 逐行改写
check("main", main, "slime:usage:recompute", "回填 IPC（main）");
check("preload", preload, "slime:usage:recompute", "回填 IPC（preload 真实现，不是只有类型声明）");
check("main", main, "rewriteUsageCosts", "逐行改写 usage.jsonl");
check("main", main, "buildPriceResolver", "回填取价器");
check("renderer", renderer, "重算历史成本", "设置页回填入口");
// ⑤ UI 可行动性：「未定价」必须与「免费」区分，且提供手填单价输入列
check("renderer", renderer, "未定价", "定价来源徽标区分「未定价」");
check("renderer", renderer, "单价 $/M（输/出）", "手填单价输入列");

console.log(fail === 0 ? "\nALL ASSERTIONS PASSED" : `\n${fail} ASSERTION(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
