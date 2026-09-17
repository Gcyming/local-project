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

/**
 * 反向断言：某段文案**必须不在**产物里。
 * 用于锁"旧行为已被彻底移除"（如 file_read 的"文件过大 → 拒绝读取"死路分支）——
 * 只断言新代码存在，无法阻止旧分支残留在某个没跑到的 if 里。
 */
function checkAbsent(group, files, needle, label) {
  const hit = files.some((pair) => pair[1].includes(needle));
  if (hit) { fail++; }
  console.log(`${hit ? "MISS" : "OK  "} [${group}] ${label}`);
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
check("main", main, "0.006", "价目表：deepseek flash 高峰缓存命中价（不再除以汇率）");
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
check("renderer", renderer, "单价 $/M", "手填单价输入列");

console.log("=== 定价虚高（A-971）：子集字段不再被当成并列项重复计费 ===");
// 事故：computeRecordCost 把 cache_read_tokens 与 reasoning_tokens 两个**子集字段**
// 按并列项相加（prompt 已含命中却又收一遍缓存价；completion 已含推理却又收一遍输出价），
// 实测整体虚高 5.02×、单条最坏 10.81×。修复是纯计算逻辑，tsc/产物都看不出来，
// 故既在源码守卫测试里锁公式，也在产物里确认新链路真的进了包：
check("main", main, "defaultCacheReadInPrompt", "按上游语义判定 prompt 是否已含缓存命中");
check("main", main, "unpricedModels", "回填结果带未定价模型清单");
check("renderer", renderer, "可在供应商面板手填", "未定价的可操作指引（不再只报条数）");

console.log("=== 分时（峰谷）定价：按请求时刻取档，不再用「峰谷均值」 ===");
// 旧做法把 DeepSeek 的峰谷价取均值（0.225/0.9）—— 那个数在**任何真实时段都不存在**，
// 单条记录最多偏 ±33%。新实现按每条记录自己的 ts 命中档位。纯逻辑改动，tsc 看不出来，
// 故在产物里确认整条链路（数据 → 解析 → 写入 → 回填 → UI）真的进了包：
check("main", main, "resolveModelPriceTier", "分时档位解析（engine/providers 共用入口）");
check("main", main, "Asia/Shanghai", "计费时区按供应商的钟（不是 UTC）");
check("main", main, "offpeak", "空闲档位进产物（deepseek 峰谷表）");
check("main", main, "price_tier", "命中的档位落盘（usage 记录可对账）");
check("main", main, "isLocalEndpoint", "本地端点闸门（本地跑 deepseek-flash 不得被按官方分时价记账）");
check("renderer", renderer, "峰谷分时", "供应商面板分时徽标（提示手填会覆盖分时价）");
check("renderer", renderer, "其余时段", "时段文案由数据生成（describePriceTiers）");
check("renderer", renderer, "按峰谷分时取档", "回填结果里可见分时条数（功能不是隐形的）");

console.log("=== 生效价单源：面板显示 = 引擎计费（旧面板只看存值 → 显示「未定价」却按 0.3 记账）===");
// 事故：面板按**配置里存了什么**显示，引擎按**表**计费，两者分裂出用户可见的矛盾 ——
// deepseek-flash 存值缺价（enrich 从未跑过）时面板显示「未定价」，但引擎实际按 0.3 计费；
// 本地端点(127.0.0.1)存值缺价时引擎还会套官方刊例价，跑本地模型凭空产生账单。
// 修复 = 抽出一个共享的生效价函数，panel/engine/回填三处共用（纯逻辑，tsc 看不出来，故锁产物）：
check("main", main, "resolveEffectivePricing", "生效价单源入口（engine 与面板共用）");
check("renderer", renderer, "resolveEffectivePricing", "面板定价列走同一入口");
check("renderer", renderer, "本地免费", "本地端点标「本地免费」而不是「未定价」");
check("renderer", renderer, "残留值", "无来源的机器臭值标「残留值」（引擎不采用）");
check("renderer", renderer, "引擎**不采用**", "存值被取代时明确告知（不让用户以为存值在计费）");
// 表格必须适配弹窗（width:680 → 内容区约 640 CSS px）：曾写 minWidth:880/920 把表格顶出容器，
// 表现为"左边只剩 sh/-pro、右边单价列不见 + 横向滚动条"。minWidth 与长列头是这次的根因，两条一起锁。
check("renderer", renderer, "上下文K", "紧凑列头（列头长度 = 列最小宽度，长列头会把表格撑宽）");
check("renderer", renderer, "单价 $/M", "紧凑单价列头（单位语义移进 title）");

console.log("=== A-978/979/981/982：文件读取分页 · diff 板块 · 产物收纳 · 右栏实时取样 ===");
// ① file_read 不再"文件过大 → 拒绝读取"（死路），改为按行分页 + 可复用的续读参数
// 目标精确到"工具读取"的那条文案：`MB），拒绝读取` 只可能来自旧的 file_read 硬拒分支
// （`config_files.ts` 的 512KB 上限是参数文件编辑器，文案是 `字节 > N`，不在本次范围）
checkAbsent("main", main, "MB），拒绝读取", "旧「文件过大 → 拒绝读取」死路分支已彻底移除");
check("main", main, "继续读取请传 offset=", "续读指引（模型能直接抄回去用）");
check("main", main, "本行超长已截断", "单行超长截断（防一行吃光预算）");
check("main", main, "DEFAULT_READ_LINES", "默认 2000 行（对齐 Claude Code）");
// ② diff：渲染层不许用 Buffer（渲染进程没有它）→ 改走 atob；机器人标记必须彻底剥离
check("renderer", renderer, "stripDiffTag", "机器标记剥离（未闭合标记也要吃掉，否则 base64 糊屏）");
check("renderer", renderer, "think-diff-row", "工具行红绿 diff 行（- 删 / + 增）");
// ③ 产物收纳：大任务几十个产物默认只显示核心 2 个
check("renderer", renderer, "个产物（点击展开）", "产物折叠入口");
check("renderer", renderer, "PRODUCT_CORE_LIMIT", "核心产物数量常量");
// ④ 右栏实时监测：拉取式取样（不再依赖事件送达）
check("renderer", renderer, "readLiveMonitor", "右栏主动取样在途快照");
check("renderer", renderer, "publishLiveMonitor", "ChatPanel 每帧写快照");

console.log("=== A-983：子代理预算（派发不再「必然超时」）===");
// 实录：审计日志里一次真实派发已做到 4/4 步，却被 300s 预算掐掉 → 用户体感"全部超时"
checkAbsent("main", main, "SUBAGENT_WAIT_DEFAULT = 33e4", "旧的 330s 等待字面量已移除（改为由预算推导）");
check("main", main, "SUBAGENT_WAIT_DEFAULT = DEFAULT_EXEC_BUDGET_MS", "等待上限由预算常量单源推导");
check("main", main, "预算 ", "超时文案带实跑时长（可区分「卡死」与「差一步」）");
check("main", main, "已保住中断前产出", "超时也保住中断前产出（不丢工作）");

console.log("=== A-984：读取卡死 / 主进程看门狗 ===");
// 用户实测"界面点按钮没反应"：流式读取对无换行符文件会按 O(n²) 撑爆缓冲 → 主进程被独占。
// 锁死"硬上限 + 无条件扫描闸 + 空结果也要有说明"，以及看门狗真的进了产物。
check("main", main, "watchdog.log", "主进程卡死看门狗落盘（下次卡顿可归因）");
check("main", main, "MAX_SCAN_BYTES", "扫描预算硬闸（单行文件不再一路读到底）");
check("main", main, "本行超长已截断", "超长单行按字符截断（常数内存）");
check("main", main, "已超出文件末尾", "offset 越界给说明而不是空串");

console.log("=== A-985：待办列表不再出现「没人在跑却显示进行中」===");
// 用户实测：强杀重启后那一项永远停在「进行中」（转圈+高亮），但并没有输入任何命令。
// 根因：in_progress 落盘后没有任何机制在"干活的进程没了"时收回来。
check("main", main, "待办收敛", "僵尸 in_progress 收敛日志（可事后核对发生过什么）");
check("main", main, "demoteStaleInProgress", "收敛入口（首次读盘 + 用户中断两处）");
check("main", main, "staleChecked", "每会话只收敛一次（不会把模型刚标记的进行中打回待办）");

console.log("=== A-986：手改待办必须落盘 + 意外退出保底 ===");
// 用户实测："我直接手动全部勾选了还是没反应" —— 根因是渲染层手改只改内存、从不落盘，
// 下一次广播就用磁盘旧值覆盖回去，且主进程的"全部完成→自动清空"（挂在 broadcastTodos 上）永不触发。
check("main", main, "slime:tasks:saveTodos", "手改待办落盘通道");
check("main", main, "slime:tasks:clearTodos", "整张清空通道（恢复手动入口）");
check("preload", preload, "slime:tasks:saveTodos", "落盘通道在 preload 有真实现（不是只有类型声明）");
check("preload", preload, "slime:tasks:clearTodos", "清空通道在 preload 有真实现");
check("renderer", renderer, "persistTodos", "渲染层手改走落盘（不再是纯内存操作）");
check("renderer", renderer, "clearAllTodos", "清空按钮接上落盘通道");
// 意外退出保底：脏标记判定 + 原子写 + 清障留证
check("main", main, "run.lock", "异常退出脏标记");
check("main", main, "crash-report.log", "崩溃报告落盘（下次启动可查）");
check("main", main, "markCleanExit", "正常退出时删标记（强杀下唯一成立的判据）");
check("main", main, "fsyncSync", "原子写（临时文件 + fsync + rename，不留半截 JSON）");

console.log(fail === 0 ? "\nALL ASSERTIONS PASSED" : `\n${fail} ASSERTION(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
