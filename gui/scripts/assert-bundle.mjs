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

/**
 * 计数断言：整个分组里 needle 的出现次数**必须恰好等于** expected。
 * 用于"同一事实只有一个产地"这类不变量 —— 存在性断言（check）抓不到"多了一份副本"，
 * 而那正是 A-1024 病根：多一份副本不会报错，只会在改键名时静默失效。
 */
function checkCount(group, files, needle, expected, label) {
  const total = files.reduce((n, pair) => n + pair[1].split(needle).length - 1, 0);
  const ok = total === expected;
  if (!ok) { fail++; }
  console.log(`${ok ? "OK  " : "MISS"} [${group}] ${label}（实测 ${total} 次，应为 ${expected}）`);
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
// A-1015b：入口唯一化 —— 原先**两颗按钮**（标题行「展开全部」+ 底部虚线框「还有 N 个产物（点击展开）」）
// 干同一件事，用户截图投诉"为什么这里显示了两个展开按钮"。现在只保留标题行那颗：
// '展开其余 N 个产物（共 M 个）' 只作为它的 title 存在，'还有 … 个产物（点击展开）' 必须不再出现。
check("renderer", renderer, "展开全部", "产物折叠入口（标题行唯一的展开/收起按钮）");
check("renderer", renderer, "收起，只看核心产物", "收起态按钮的 title（同一个入口负责两个方向）");
check("renderer", renderer, "展开其余 ", "「还有 N 个」信息并进 title（不额外占竖向空间）");
checkAbsent("renderer", renderer, "个产物（点击展开）", "重复的第二个展开按钮已移除（同一动作只有一个入口）");
check("renderer", renderer, "PRODUCT_CORE_LIMIT", "核心产物数量常量");
// A-1015 / A-1015b：展开收起的衔接动画基础设施必须进**产物**。
// 注意运行时的 assert-collapse-anim.cjs 读的是 src/renderer/index.css（源码），
// 所以"规则被构建流程吞掉/改名"只有这里能发现 —— 两份守卫互补，不要删其一。
check("renderer", renderer, "--pop-dur: 0.18s;", "浮层节拍变量进了产物 CSS");
check("renderer", renderer, ".pop.pop-up { transform: translateY(4px) scale(0.985);", "向上气泡的位移方向（与 .pop 相反）进了产物");
check("renderer", renderer, ".collapse.is-open {", "高度插值的展开态进了产物");
check("renderer", renderer, "pop pop-up", "浮层类名真的被用到了（不是只有 CSS 定义）");
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

console.log("=== A-988c：换行渲染修复 · 自定义分时档 · 缓存价逐字段来源 ===");
// ① 换行（用户投诉："怎么又出现换行错误了"）：nowrap 与 flexShrink 必须**成对**进产物。
//    只补其一会分别表现为"溢出撑破弹窗"或"仍然断行"，构建产物里两者都要在。
check("renderer", renderer, "nowrap", "nowrap 进了产物（文字层防断行）");
check("renderer", renderer, "flexShrink", "flexShrink 进了产物（布局层防压缩）");
check("renderer", renderer, "价目明细 ·", "价目明细行本体在产物里（守卫对象真实存在）");
// 数量也要够：标题与「收起」按钮**各自**都要 flexShrink:0，只给一个写 = 另一个仍会被压缩。
// 这里按"出现次数"断言而不是按字面量 —— 打包器对空格的处理不稳定（`flexShrink: 0` / `flexShrink:0`），
// 字面量断言会变成随打包器版本飘的假红灯。
{
  const js = renderer.filter(([p]) => p.endsWith(".js")).map(([, s]) => s).join("\n");
  const countOf = (needle) => js.split(needle).length - 1;
  const shrink = countOf("flexShrink");
  if (shrink >= 2) { console.log(`OK   [renderer] flexShrink 出现 ${shrink} 次（双保险：标题与按钮各自都有）`); }
  else { fail++; console.log(`MISS [renderer] flexShrink 只出现 ${shrink} 次（需要 ≥2：标题与按钮各一处）`); }
  const nowrap = countOf("nowrap");
  if (nowrap >= 3) { console.log(`OK   [renderer] nowrap 出现 ${nowrap} 次（换行修复覆盖多处而不是孤例）`); }
  else { fail++; console.log(`MISS [renderer] nowrap 只出现 ${nowrap} 次（<3，疑似只补了一处）`); }
}
// ② 自定义分时档：规格类型、时段编辑器控件、跨午夜文案、导入入口
check("renderer", renderer, "分时（峰谷）定价 · 自定义", "自定义分时编辑器进了产物");
check("renderer", renderer, "改为自定义", "「改为自定义」入口");
check("renderer", renderer, "兜底档", "兜底档在 UI 上被标注（否则用户不知道没命中时段时按哪个价）");
check("renderer", renderer, "（次日）", "跨午夜时段文案（23:00-07:00 不会被读成从早到晚）");
check("renderer", renderer, "IANA 名", "计费时区提示（分时按供应商的钟判定）");
check("main", main, "normalizePriceTiers", "自定义分时规格的校验在 main（脏数据不得写进配置）");
check("main", main, "price_tiers", "自定义分时规格的落库字段名进了产物");
// ③ B1 的另一半：缓存价来源必须逐字段（readSource / writeSource），不能再共用一个
check("main", main, "cacheRateReadSource", "缓存价来源按字段分开（read）");
check("main", main, "cacheRateWriteSource", "缓存价来源按字段分开（write）");
check("renderer", renderer, "推定不收费", "非 Anthropic 系的缓存写入显示为「推定不收费」而不是编造的 1.25×");
check("renderer", renderer, "缓存未命中", "输入字段标签按计量口径统一（缓存未命中）");

console.log("=== A-988d：上游定价探针的表驱动覆盖（各家厂商字段名） ===");
// 探针从"硬编码 ?? 链"改为字段表；表必须进产物，且五个槽位一个都不能少。
check("main", main, "UPSTREAM_PRICE_FIELDS", "上游价格字段探针表进了产物");
check("main", main, "CACHE_RATIO_FIELDS", "乘数型缓存字段（new-api/one-api 倍率）进了产物");
check("main", main, "parseUsdPerMillion", "统一单位换算入口（per-token / per-1M / auto）");
// 表驱动必须覆盖到具体字段名（这些字符串是各家上游 API 的契约，压缩不会改名）
for (const [needle, label] of [
  ["input_cost_per_token", "LiteLLM input_cost_per_token"],
  ["input_cost_per_1m_tokens", "per-1M 命名变体"],
  ["cache_read_input_token_cost", "LiteLLM 缓存命中"],
  ["cache_creation_input_token_cost", "LiteLLM 缓存写入"],
  ["input_cache_read", "OpenRouter 缓存命中"],
  ["input_cache_write_1h", "Anthropic 1 小时写入档（与 5 分钟档差 1.6 倍，必须分槽）"],
  ["pricing_time_tiers_candidate", "上游时段档候选落库"],
  ["pricing_context_tiers", "上游上下文分档落库"],
  ["pricing_per_request", "上游按次单价落库"],
]) { check("main", main, needle, label); }
// 采集结果必须能在面板上看到并使用（采集而不展示 = 没采集）
// 匹配串只取稳定语义子串：这块 UI 的标题随覆盖范围改过名
// （"上游探针采集到的…" → "探针 / 镜像采集到的…"，因为快照/镜像来源也要展示），
// 断言绑标题全句会把正常的文案演进变成假红灯。绑"采集到的定价信息"这一段即可。
check("renderer", renderer, "采集到的定价信息", "面板展示探针采集结果（用户能判断探针是否生效）");
check("renderer", renderer, "导入上游时段", "上游时段档可一键导入");
check("renderer", renderer, "不参与计费", "上下文分档明确声明不参与计费（不硬套不存在的维度）");
check("renderer", renderer, "不计入 token 账目", "按次单价明确声明不入 token 账目（避免造出巨大假账）");

console.log("=== A-990：$ 与 ¥ 分开（分币种存放 + 分币种展示） ===");
// 用户诉求原文：「你给我分汇率算，把＄跟人民币分开。」
// 这条要求在产物层至少要看到三件事，缺一件就等于用户又只能看到一个"不知道是什么币种"的数字：
//   ① 折算率只有一个出处（USD_CNY_RATE 常量），不允许各文件自己写 7.2 / 7.25；
//   ② 档位对象带**原生人民币**字段（priceInCny 等键名，压缩不会改名）；
//   ③ 分时明细表明确声明会并列显示 ¥（否则数据存了却看不出来 = 白存）。
{
  const js = renderer.filter(([p]) => p.endsWith(".js")).map(([, s]) => s).join("\n");
  const hits = js.split("USD_CNY_RATE").length - 1;
  if (hits >= 1) { console.log(`OK   [renderer] 折算率常量进了产物（被 ${hits} 处引用，均指向同一常量）`); }
  else { fail++; console.log("MISS [renderer] 折算率常量没进产物"); }
}
for (const key of ["priceInCny", "priceOutCny", "priceCacheReadCny", "priceCacheWriteCny"]) {
  check("main", main, key, `档位/定价带原生人民币字段 ${key}`);
}
check("renderer", renderer, "官方公布过人民币价的档位会并列显示", "分时明细表声明双币种并列展示");
check("renderer", renderer, "折算", "界面明示「折算值」概念（≈$ 不冒充官方美元价）");

console.log("=== A-990：以模型所属地决定总账币种 ===");
// 用户指令：「这个以模型所属地决定，金额尽量靠近整数，转汇率的时候经常出现小数点，看着不舒服。」
// 三处证据：① 用量面板按归属地选币种并交代账目原值；② 海外厂商的说明文案；
// ③ 折算率常量在产物里（唯一定义面，见上）。硬编码 7.25 已被源码守卫锁死（见 providers-pricing.spec.ts）。
check("renderer", renderer, "模型归属地显示", "用量面板按模型归属地选总账币种");
check("renderer", renderer, "海外厂商以美元计价", "海外厂商币种说明（不是无脑折人民币）");
// ⚠️ 这里**不做**"硬编码 7.25 必须不在产物里"的反向断言 —— 实测不可行：
//    renderer 产物**保留注释**（本次构建 2.3MB 带注释产出），而"7.25"同时出现在
//    我们**刻意保留的历史事故注释**里（那是给后人看的记录，必须留）。
//    产物层因此无法区分"注释里提到"与"代码里在用"。
//    → 反向守卫改在**源码层**做：tests/core-ts/providers-pricing.spec.ts 的
//      「源码守卫：折算率不许再出现第二处」逐行扫描代码行（注释行放行），
//      并带一条"守卫自检"用例证明规则本身有效（不是空转）。
//    教训：**注释会进产物**，所以任何基于产物字符串的反向断言都要先确认注释是否保留。

console.log("=== A-990：ChatPanel 纯逻辑抽取（结构解耦） ===");
/*
 * 为什么断言**函数名**而不是文案：本项目的 renderer 产物实测**不做压缩改名**
 * （esbuild 保留标识符与注释），所以 `extractProducts` 这类名字在产物里是可靠的。
 * 这比断言注释文案强得多 —— 注释随时会被重写，函数名是接口的一部分。
 */
// 被抽出去的三块纯逻辑各自仍必须真的进产物（漏了 import 会在构建期报错，但"进了产物"是可复核的正向证据）
for (const fn of ["extractProducts", "parseDiffStat", "parseDiffFull", "diffLines", "stripDiffTag"]) {
  check("renderer", renderer, fn, `产物解析（chatProducts.ts）的 ${fn} 进了产物`);
}
check("renderer", renderer, "productIconUrl", "图标映射（productIcons.ts）进了产物");
check("renderer", renderer, "publishLiveMonitor", "在途快照写入（liveMonitor.ts）进了产物");
check("renderer", renderer, "readLiveMonitor", "在途快照读取（liveMonitor.ts）进了产物");
check("renderer", renderer, "ledgerCurrencyOf", "账目币种判定（usageCurrency.ts）进了产物");

console.log("=== A-990-B：用户手选币种（手动调整币种填入 + 消耗按选择显示） ===");
// 用户指令：「模型定价中，我希望可以手动调整币种填入，然后消耗时再按照用户选择显示消耗为＄还是￥。」
check("renderer", renderer, "单价币种", "定价面板出现「单价币种」选择器");
check("renderer", renderer, "恢复自动", "可清除手选、恢复按归属地自动判定");
check("renderer", renderer, "按归属地", "界面交代当前币种是手选还是自动判定");
check("renderer", renderer, "pricingDisplayCurrency", "币种判定入口（用户选择 > 归属地）进了产物");
check("renderer", renderer, "isNativePriceCurrency", "原生价/折算价判据进了产物（≈ 前缀据此打）");
check("main", main, "price_currency", "主进程落盘字段 price_currency 进了产物（漏了会被静默丢弃）");
check("main", main, "modelCurrencies", "用量快照下发用户手选币种（报表与账目同一次下发）");

console.log("=== A-990-C/E/F/G/H：单价原生列 · 探针诊断 · 价格核实日期 · 精确id vs 家族兜底 ===");
check("renderer", renderer, "探针诊断：", "面板给出「探针为什么没价」的诊断（回答用户的「探针探不到吗」）");
check("renderer", renderer, "价格核实于", "面板显示价格核实日期（时效性必须在界面上可见）");
check("renderer", renderer, "未知（需复核）", "无核实日期的厂商显示为「未知」而不是假装新鲜");
check("renderer", renderer, "价目匹配：家族兜底", "家族正则命中的行被标注「可能偏离」（用户指出的病根）");
check("renderer", renderer, "价目匹配：精确 id", "精确条目被标注为已逐条核对");
// 这两个只被渲染层用到（main 侧用不到，会被 tree-shake 掉）→ 断言 renderer
check("renderer", renderer, "amountInCurrency", "单价原生列判据（按字段）进了产物");
// ⚠️ 不要断言 `pricingMatchKind`：它只被**测试**调用，渲染层用的是数据字段
//    `eff.pricingMatch`，所以函数名会被 tree-shake 掉（断言它会变成假红灯）。
//    判据"确实生效"的证据是上面两条 UI 文案断言 —— 只有当 `pricingMatch` 被真正算出来时才会渲染。
check("renderer", renderer, "pricingMatch", "生效价带出「命中方式」字段（UI 据此标注兜底）");

console.log("=== A-1001：分时（峰谷）价的展示必须跟着「此刻」走 ===");
/*
 * 用户实测提问：「这个可填入的表格的加码没有随着波峰波谷规定的时间变动而改变，
 * 这会影响分时价位的生效吗？」
 * 事实是两半：引擎侧一直生效（recordUsage 传 at = new Date() 并写 price_tier）；
 * 面板显示用了"不带时刻"的确定性口径 → 与下方「空闲时段 ● 当前」同屏打架。
 * 断言要点：主口径带时刻、单价框自述带档位名、有让"此刻会走"的 tick。
 */
check("renderer", renderer, "当前计费价", "命中分时档时显示「当前计费价」（不再用静态口径的字面量）");
check("renderer", renderer, "不是配置被改动了", "悬停解释数字为何随时间变（否则用户以为配置被改 / 分时没生效）");
check("renderer", renderer, "平铺 / 高峰标准价", "列表徽标悬停交代分时模型那一行是不带时刻的标准价（两处口径不同是有意为之）");

console.log("=== A-1002：分时界面与手动单价界面**互斥显示**（不是删掉其中一套） ===");
/*
 * 用户指令（原话）：「有分时的模型就不显示这个配置界面，只显示分时界面，没分时的或者没配置的
 * 就显示这个界面。**当然，我不是让你删了，而是做一个额外的条件选择显示的功能**。」
 * 产物层要守的只有一件事：**两套配置都还在**，且切换入口（页面签）真的进了包。
 * 「默认给哪一套」是运行时从 `eff.origin` 反推的，源码守卫在
 * tests/core-ts/pricing-tiers.spec.ts 的 A-1002 / A-1002b（含 `.btn` 边界的静默失效）。
 */
check("renderer", renderer, "定价方式", "切换条存在（用户据此在两套配置间切换）");
check("renderer", renderer, "分时（峰谷）定价", "「分时」页签进了产物（分时界面没被删）");
check("renderer", renderer, "手动单价", "「手动」页签进了产物（手动单价界面没被删）");
check("renderer", renderer, "● 生效中", "「生效中」标记（从 eff.origin 反推，不是「配置里填了什么」）");
check("renderer", renderer, "手动单价输入已隐藏", "切到分时视图时明确告知手动输入是被隐藏而非删除");
check("renderer", renderer, "分时档位编辑已隐藏", "切到手动视图时明确告知分时编辑是被隐藏而非删除");
check("renderer", renderer, "清空手填", "手填价的清理出路仍可达（切走后再也清不掉 = 硬删）");
check("renderer", renderer, "改为自定义", "自定义分时档入口仍在（互斥显示不得顺手摘掉编辑能力）");

console.log("=== A-1003：运行环境三项「检测不到」的根因修复（随包资源根 / 旧配置 / 体积门槛） ===");
/*
 * 用户实测：设置 → 运行环境里 Python（随包 venv）/ llama.cpp / 本地模型 **三项齐报「缺失」**，
 * 而三份资源都在磁盘上且真能跑（venv Python 3.12.9 + fastapi 可导入；llama-server.exe
 * --version → build 10509；BGE-M3 561MB / qwen3-1.7b 1GB 存在）。三层原因各有产物证据：
 *   ① 开发模式随包资源根错用 `app.getAppPath()`（= gui/）→ llama.cpp / runtime/venv /
 *      models / slime_server.py 全部落空（连 Python sidecar 都被判「后端组件缺失」）。
 *   ② bootstrapToml（负责矫正 llama_bin / model_path / models_dir）被 `if (app.isPackaged)`
 *      整段包住 → 开发模式永不执行，配置里指向另一份检出的死路径长期不修。
 *   ③ llamaBin 就绪判据是「≥1MB」，而 llama.cpp 官方预编译是 shared-libs 布局 ——
 *      `llama-server.exe` 只是 9216 字节薄壳，真正代码在 ggml-*.dll → 可用二进制被判缺失。
 */
check("main", main, "findProjectRoot", "① 开发模式向上找 slime.toml 推导随包资源根（不再是裸 app 根）");
check("main", main, "BUNDLE_ROOT", "① 随包依赖根与安装根分离（BUNDLE_ROOT 进了产物）");
check("main", main, "resolveBundled", "① 随包依赖取用点统一走 resolveBundled");
check("main", main, "开发模式：随包资源根", "② 开发模式也执行 slime.toml 路径矫正（启动日志可自证）");

/*
 * 魔数判据与体积门槛都**必须限定在函数体内**核对。
 * 为什么：`1024 * 1024` 在产物里还有 20+ 处无关用途（history.jsonl 上限、读盘上限…），
 * 全局 checkAbsent 一定是假红 —— 这是本文件最容易写错的一类断言。
 */
const looksLikeExec = main.map(([p, s]) => {
  const i = s.indexOf("function looksLikeExecutable");
  if (i < 0) { return [p, ""]; }
  const j = s.indexOf("\n}", i);
  return [p, s.slice(i, j < 0 ? i + 800 : j + 2)];
});
check("main", main, "looksLikeExecutable", "③ llamaBin 就绪判据改为文件头魔数（与构建布局无关）");
checkAny("main", looksLikeExec, ["buf[0] === 77 && buf[1] === 90", "buf[0] === 0x4d && buf[1] === 0x5a"], "③ PE 魔数 \"MZ\" 判据在函数体内");
checkAny("main", looksLikeExec, ["buf[1] === 69 && buf[2] === 76", "buf[2] === 0x45"], "③ ELF 魔数判据在函数体内");
check("main", looksLikeExec, "st.size < 1024", "③ 空文件/残片仍有 1KB 下限（判据没退化成「存在即就绪」）");
checkAbsent("main", looksLikeExec, "1024 * 1024", "③ 体积门槛已从就绪判据移除（9KB 薄壳不再被判缺失）");
checkAbsent("main", looksLikeExec, "size >=", "③ 就绪判据不再比较文件大小（只认文件头）");

console.log("=== A-1008：群聊「跑出一个 Agent 总结复读」+「重启后历史只剩它」 ===");
/*
 * 用户实测两个症状（历时很久、反复修还是这样）：
 *   ① 成员说完话后，总有一个 Agent 出来把所有内容总结复述一遍；
 *   ② 退出 slime 重启，历史会话消失，只剩那个"总结的 Agent"。
 *
 * ⚠️ **两个根因，不是一条**（第一轮只修了 A，用户回"依旧存在" —— 因为当轮气泡走的是 B）：
 *   A. **落库形状**：群聊把全体发言拼成一个大字符串、只写**一条** history 记录；读回时
 *      产出的消息不带 agentName/agentId → 渲染层回退到"会话归属 Agent"的名字。
 *      修法：每个成员的发言作为结构化 turns 一并落库，读回时展开成逐成员多条气泡。
 *   B. **done 回退**：`createStreamSession.pushChunk` 原本**无条件**累积 `fullReply`，
 *      把群聊 `member` 事件（也带 content）当成"本会话 Agent 的正文"；而群聊 done 的
 *      `reply` **恒为 ""**（A-946 收束由用户）→ `cleanReply ?? session.fullReply` 回退到
 *      被污染的 fullReply → 渲染层见非空 reply 就追加**一条无归属气泡**。
 *      修法：只在 `chunk.type === "chunk"` 时累积。
 *
 * 产物层能守的（下面两条分别对应 A 与 B）：
 *   A → main 落库结构化 turns + 下发失败标记；renderer 按成员气泡 + 失败徽标 + 开关可见。
 *   B → main 里"只累积本会话正文"的那个闸门（下面那条 `chunk.type === "chunk" &&` 断言）。
 * 「JSX 里开关到底有没有藏在群聊隐藏块内」是结构问题，断言文案存在证明不了，
 * 由 tests/core-ts/gui-network-toggle.spec.ts 的"位置"守卫负责。
 */
check("main", main, "chunk.type === \"chunk\" && chunk.data.content", "B 根因闸门：fullReply 只累积本会话 Agent 正文（成员发言不再污染 done 回退）");
check("main", main, "speechEnd", "A 根因：成员发言结束通知进了产物（UI 据此把失败气泡降级为错误样式）");
check("main", main, "本次发言失败", "① 失败占位文本仍由引擎写进正文（但已被排除出喂给其他成员的语境）");
check("main", main, "slime:brainstorm:event", "① 群聊状态广播仍在（成员 thinking/speaking/done 实时可见）");
check("renderer", renderer, "发言失败", "② 群聊气泡带「发言失败」徽标（报错串不再伪装成成员观点）");
check("renderer", renderer, "slime_network_enabled", "② 联网开关的唯一实现进了渲染层产物（networkToggle.ts）");
check("renderer", renderer, "联网搜索：未启用（点击开启）", "② 开关的关闭态文案在产物里（关闭时用户看得见「现在是关的」）");

console.log("=== A-1008：端点拼接唯一实现（智谱 /v4 被拼成 /v4/v1/... → 上游 404） ===");
/*
 * 事故：`ChatClient.endpoint` 只硬化了 `endsWith("/v1")`，而智谱官方 base 是
 * `https://open.bigmodel.cn/api/paas/v4` → 拼出 `/api/paas/v4/v1/chat/completions` → 404，
 * 表现为「群聊里某个成员每一轮发言都失败」（用户实测 t2 绑 glm-4.5-air:free）。
 * 修法：抽出 `joinApiEndpoint` 做**唯一实现**，版本段改用通配 `/\/v\d+[a-z]*$/i`
 * （同时覆盖 /v4、/v1beta 这类字母后缀），Chat / Anthropic / Responses / Gemini
 * 四个客户端 + thread_worker 宿主侧共 6 处共用。
 *
 * ⚠️ 这里**故意不用** checkAbsent 断言旧写法 `endsWith("/v1beta")`：源码里保留了记录
 *    本次事故的注释，而 main 产物实测**会保留注释**（与 A-990 段"注释会进产物"同一教训），
 *    一旦构建策略变动就会变成假红灯。语义正确性由 tests/core-ts/client.spec.ts 的
 *    joinApiEndpoint 正交用例锁死（含智谱 /v4、/v1beta、幂等、尾斜杠），
 *    这里只证明"新实现真的进了包"。
 */
check("main", main, "joinApiEndpoint", "端点拼接唯一实现进了 main 产物（多客户端共用）");
check("main", main, "/\\/v\\d+[a-z]*$/i", "版本段通配正则进产物（不再只认 /v1）");

/* ── A-1011：群聊成员的思考推理强度（会话级）─────────────────────────
 * 需求三条：① 群聊顶栏不再显示恒 0% 的上下文圆环；② 右栏每张成员卡可展开调该成员
 * 推理强度；③ 一律只作用于群聊板块。
 *
 * 断言理由（每条都在防一个具体的坏结局）：
 *  - setMemberEffort 频道名：少了它，UI 点了没反应且**静默**（渲染层是乐观更新，
 *    没有 IPC 就只有本地状态、刷新即丢）。这是"看起来能用"的最坏形态。
 *  - 群聊成员组装必须显式注入 reasoning_effort：`toParticipant` 不再写死 high，
 *    注入点漏了会静默回落到该 Agent 的**全局**强度 —— 恰好违背"只作用于群聊"这条边界。
 *  - "思考·" 文案：成员卡上那个可展开按钮本体。
 *  - EFFORT_LABEL 的等级中文名：按钮展开后的等级胶囊（压缩后字符串字面量仍在）。
 */
check("main", main, "slime:sessions:setMemberEffort", "群聊成员推理强度 IPC 频道进了 main 产物");
check("preload", preload, "slime:sessions:setMemberEffort", "preload 有真实现（不是只有类型声明）");
check("main", main, "memberEffortsOf", "成员强度映射派生进了 main 产物");
check("renderer", renderer, "思考·", "成员卡「思考·<等级>」可展开按钮进了产物");
check("renderer", renderer, "本地模型（llama.cpp）的思考由模板参数", "不给假旋钮：本地模型给出「等级不生效」的说明文案");

/* ── A-1012：群聊席位上限（含组长）在**建群弹窗**就拦住 ─────────────────
 * 症状：邀请 7 个 Agent 建群，第 6 位起右栏卡片照常显示、照样能点「思考·X」，
 * 但引擎 `.slice(0, 5)` 从不读它们（静默丢弃 = 假旋钮）。修法不是调大 5，
 * 而是让上限只有一个出处（`shared/gen/groupRoster.ts`），引擎组装名单与
 * 建群弹窗拦人共用它 —— 所以断言要同时钉住**两侧**：
 *  - main：参与名单由 `groupParticipantIds` 决定（少了它 = 上限又回到引擎私有）；
 *  - renderer：满员文案进产物（少了它 = 弹窗又变成不限量邀请）。
 * 源码结构守卫（不许内联 `.slice(0, N)` / 不许硬编码 5）在
 * `tests/core-ts/group-talk-roster.spec.ts`，那里能断言"不存在"，产物层只能正向断言。
 */
check("main", main, "groupParticipantIds", "群聊参与名单由共享纯函数决定（上限不再是引擎私有）");
check("renderer", renderer, "已达群聊上限", "建群弹窗把群聊人数上限显式写出来（不再静默邀请）");
check("renderer", renderer, "已满员", "满员时未入群候选带「已满员」标记（不给假动作）");

/* ── A-1013：右栏「思考碰撞」流的持久化 + 唯一写入路径 ─────────────────
 * 用户症状两条：①「退出重启后内容一直消失」（流只活在 React state）；
 * ②「每次 Agent 输出完消失得七七八八，只剩总结」（thinking 追加 vs idea 整批覆盖，
 * 两条写入路径语义不一致）。修法：状态机 + 按会话落 localStorage，两种事件共用一条路。
 *
 * 断言理由（每条都在防一个具体的坏结局）：
 *  - `slime_bsflow_`：存储键前缀。少了它 = 流又只活在内存里（症状①原样复发），
 *    而 localStorage 写入失败是**静默**的，跑测试与类型检查都不会报。
 *  - `本栏随群聊保存`：空态文案里对用户的**承诺**。承诺在、机制不在是最坏的组合，
 *    所以本文案与存储前缀必须**同时**在产物里（缺一条就是回归）。
 *  - `条已折叠`：超上限时的显式提示（旧实现 `slice(-120)` 静默丢内容，用户最恨这点）。
 *  - `思考碰撞`：栏目标题本体（防重排时把整段渲染丢掉）。
 * 正向断言的边界说明：源码层的"不存在第二条 setFlow / 不存在 slice(-N)"只能在
 * `tests/core-ts/brainstorm-flow.spec.ts` 断言（产物层做不了否定断言）。
 */
check("renderer", renderer, "slime_bsflow_", "思考碰撞流按会话落 localStorage（重启后还能回看）");
check("renderer", renderer, "本栏随群聊保存", "空态对用户的承诺与持久化机制同时进产物");
check("renderer", renderer, "条已折叠", "超上限时显式提示已折叠条数（不再静默丢内容）");
check("renderer", renderer, "思考碰撞", "「思考碰撞」栏目本体进了产物");

/* ── A-1014：图形控制的诚实性（静默打偏 / 假报聚焦 / 静默 1:1）─────────────
 * 用户症状：「操控时总是糊涂」+「能不能不置顶、在下层窗口干活」。
 * 三条断言各钉住一个**静默失败**（这三类失败跑测试、跑 tsc、看日志都不会报）：
 *  - `坐标基准缺失`：没有截图基准时不再猜比例。少了它 = 图像像素被当物理像素，
 *    屏幕宽 >1600（截图会缩到 1600）时是系统性偏移，且比例恰好 1.0 连日志都看不出异常。
 *  - `Move-SlimeCursor`：指针定位的唯一入口。少了它 = 9 处 `SetCursorPos(...)|Out-Null`
 *    复活，移动失败时指针原地不动、点击打在旧位置。
 *  - `未能把窗口`：抢不到前台时的**如实**说明。少了它 = `focus` 又无条件宣布成功，
 *    随后截到/点到的是压在上面的另一个窗口。
 * 多屏原点的透传（`originX/originY`）不在产物层断言：`originX` 在 main 产物里到处都有，
 * 正向断言没有判别力 —— 它由 tsc（`DisplayInfo` 字段）+ `tests/core-ts/screen.spec.ts`
 * 的负原点折算用例守。
 */
check("main", main, "坐标基准缺失", "无截图基准时明确报错（不再静默按 1:1 当物理像素）");
check("main", main, "Move-SlimeCursor", "指针定位收口到唯一入口（SetCursorPos 返回值不再被吞）");
check("main", main, "未能把窗口", "抢不到前台时如实说明（focus 不再无条件谎报成功）");

/* ── A-1017：幽灵会话 + 本地模型加载面板（两条都是"改回去不报错"的静默回归）──────
 * 用户症状：「无法使用任何模型，而且无法删除」+「每次对话都会弹加载本地模型」。
 *  - `跳过孤儿历史的会话迁移`：迁移必须校验 Agent 仍存在。少了它 = 历史里任何孤儿 agent_id
 *    （测试夹具写进真实 history.jsonl 的 agent_test1 就是）都会变成绑不存在 Agent 的幽灵会话。
 *  - `clearLegacySessionHistory`：删除会话要连"没有 session_id 的遗留历史"一起清。少了它 =
 *    删掉之后下一次列表刷新又把它建回来（用户体感"删不掉"，且每次复活换一个新 sessionId）。
 *  - `本地模型开始加载` / `onChatState`：加载面板改由管理器状态广播驱动。少了它 = 退回
 *    "调用方自己算就绪没有"（另读一份 providers 表 + 裸路径比较），模型已就绪也每轮弹面板。
 */
check("main", main, "跳过孤儿历史的会话迁移", "孤儿历史不再为不存在的 Agent 建幽灵会话");
check("main", main, "clearLegacySessionHistory", "删会话连遗留历史（无 session_id）一起清（否则删了又复活）");
check("main", main, "本地模型开始加载", "加载面板由管理器状态广播驱动（不再由调用方预判）");
check("main", main, "onChatState", "管理器状态广播的订阅真的接进了主进程");

/* ── A-1021b：思考历程时间线"凭空消失"这条链 ───────────────────────────────────
 * 用户症状（截图）：思考过程里只剩**一个**节点、展开是一大坨可滚动的字，时间线形态消失。
 * 两个缺陷叠加：① onDone 在「done 的会话不是当前会话」时早退 → 时间线既不落 localStorage
 * 也不落 history.jsonl（取证：history.jsonl 第 97 行 elapsed_ms=349872 = 截图「回复耗时 349.9s」，
 * timeline 缺失）；② A-966 写的历史时间线**只写不读**，加载侧只认 localStorage。
 *
 * ⚠️ 这里**必须**同时断言 preload：调用点是
 *   `void attachApi?.chat?.attachTimeline?.(...)` —— 一路可选链，**preload 少暴露一层就静默失效**，
 *   不报错、不崩、不亮红，只有用户下次打开历史时发现时间线又没了。这正是本项目最贵的一类缺陷。
 * 落盘通道（IPC 名）与渲染层的时间线样式类是字符串字面量，压缩后仍在，可以可靠断言。 */
check("main", main, "slime:chat:attachTimeline", "时间线落盘通道在主进程注册");
check("preload", preload, "slime:chat:attachTimeline", "该通道真的暴露给了渲染层（可选链调用，缺了会静默失效）");
checkAny("renderer", renderer, ["think-step-mark", "think-step-text"], "时间线节点样式进了渲染产物（设计没被换掉）");

/* ── S1（A-1022）：本地模型「能力问询」替换推断 ───────────────────────────────
 * 用户症状：本地模型界面显示"还剩 480K"，请求却被上游 400 顶回
 *   `request (13811 tokens) exceeds the available context size (8192 tokens)`。
 * 根因是上限靠推断（最后落到家族能力表 = 训练窗口 524K），而没人问过服务器实际分配了多少 KV。
 *
 * ⚠️ 与 A-1021b 同一类风险：探针链路是**跨进程 + 全可选链**的，
 *   `probeManagedChatCapability(...).catch(() => null)` 一旦拿不到就静默回落到兜底值 ——
 *   不报错、不崩，只是界面又悄悄显示错数字。所以必须在**产物层**确认三件事都真的进了包：
 *   ① `/props` 这个端点的字符串（探针真的被打进主进程产物）
 *   ② `unavailable_error`（"加载中"的识别：三端点 503 信封，实测 /health 也不豁免）
 *   ③ 回归告警文案（就绪却解析不出 n_ctx 时必须留痕，否则端点半结构变了没人知道）
 *
 * ⚠️ 断言串必须是**代码里**独有的形态 —— 本脚本第一版用了裸 `/props`，变异测试当场证伪：
 *   把 `propsUrlFor` 的端点改成 `/xprops` 重新构建后，断言**依然全绿**（10 处命中仍在）
 *   = 一条完全无效的守卫。A-1019 的老教训：守卫必须用变异测试自检（改坏 → 必须红）。
 *
 *   📌 机制更正（实测复核）：早先这里写的"主进程产物保留注释"是**错的**。
 *   `gui/vite.config.ts` 没有 minify 覆盖 → esbuild 默认：**标识符保留**（实测
 *   `basePortFor` 6 次 / `localModelSpecs` 5 次 / `ModelServerManager` 10 次），
 *   **普通注释一律剥离**（out/main 里中文注释 0 命中，只剩 2 处 `/*!` 法律注释）。
 *   所以那 10 次命中来自**别的字符串字面量**（如回归告警里的
 *   `"…检查 /props 与 /v1/models…"`），而不是注释。结论不变、理由必须准：
 *   裸 `/props` 之所以是坏断言，是因为**同名字符串散落在错误文案里**，改端点时它们不会跟着变。 */
check("main", main, "stripApiSuffix(base)}/props", "能力问询端点真的存在（否则上限又只剩推断）");
check("main", main, '=== "unavailable_error"', "「加载中」按 503 信封识别（/health 也回这个信封，不能靠超时猜）");
check("main", main, "本地模型加载中（/props 503", "加载态有读取者（回归信号不再被静默吞掉）");

/* S2（A-1023）：嵌入端口收口到唯一来源。
 * 原病灶：`gui/src/main/index.ts` 的 `bgeEmbed` 直接 fetch `http://127.0.0.1:8999`，
 * 绕过了 `basePortFor()` —— 用户一旦在 slime.toml 改 embedding 端口，管理器在新端口起服务、
 * 这里仍问旧端口 → 嵌入永远失败 → MemoryStore **静默降级成哈希**（只是检索质量悄悄变差）。
 * 断言串取 `getPort("embedding")`：实测在 main 产物里**恰好 1 次**且是代码形态（注释不会长这样）。
 *   第二条取 `basePortFor("embedding", cfg.embedding` —— 这是 **index.ts 独有**的调用形态
 *   （model_server.ts 里是 `..., cfg, this.chatCfg)` / `..., this.embedCfg, this.chatCfg)`，
 *   若只写 `basePortFor("embedding"` 会命中它们 3 次，删掉 GUI 那处后断言仍然绿）。 */
check("main", main, 'getPort("embedding")', "嵌入端口优先问管理器自述（已就绪即用真实端口，不再硬编码）");
check("main", main, 'basePortFor("embedding", cfg.embedding', "未就绪时按共享的 basePortFor 推导（与启动口径同源）");

/* S4-D：状态迁移必须作废能力缓存。
 * 病根：`clearLocalCapabilityCache()` 此前**只有测试在调**（文档却声称"模型切换/服务重启时用"），
 * 而 `probeManagedChatCapability()` 问询时不传 alias → 缓存 key 只到端口，
 * 模型切换又恰好发生在同一个端口上 → 切换后最多 2s 拿**上一个模型**的 n_ctx
 * （A-1018 ③ 的形状：界面按旧模型显示窗口）。
 * 断言串取**调用形态** `clearLocalCapabilityCache();`（带分号）——定义处是
 * `function clearLocalCapabilityCache() {`，两者不会互相命中。已用变异测试验红。 */
check("main", main, "clearLocalCapabilityCache();", "状态迁移作废能力缓存（同端口换模型不再按旧模型显示窗口）");

/* S5（A-1018 ③）：写进 provider 配置的窗口必须走**唯一决策点**。
 * 病根：`gui/src/main/providers.ts` 拿家族能力表（模型**训练时**的窗口，dots/qwen = 512K/128K）
 * 给本地端点填 `context_window` → 渲染层在"第一次 done 之前"就按训练窗口显示，
 * 而 llama-server 实际只按 `-c 8192` 分配 KV（请求被上游 400 顶回）。
 *
 * ⚠️ 这里**只**能断言"决策函数进了产物"，**不要**再写 `checkAbsent("ctxFromFamily")` 之类的
 * 「旧局部变量不存在」断言 —— 实测它是个**假绿**：把旧链路加回去（`const ctxFromFamily = …`），
 * 只要那个变量没被使用，esbuild 就把它**整个 tree-shake 掉**，产物里依然找不到它，
 * 断言照样 OK。这正是本项目反复踩的"定义在产物层不可观测"（同 `function localModelSpecs(` 那次）。
 * 结论：**「本地端点不吃家族兜底」是源码层事实**，由 `tests/core-ts/a1026-guards.spec.ts`
 * （结构 + 行为）与 `gui/scripts/mut-a1026-wincap.mjs`（10 条变异，全红）锁定，产物层只管
 * "决策点真的被引用进了 bundle"（引用了才不会被 tree-shake → 这条本身是有效的）。 */
check("main", main, "providerCtxWindow(", "窗口写入走唯一决策点（providerCtxWindow 已被引用进产物）");

/* S3（A-1024）：本地模型清单的键名只有一个产地。
 * 病根不是"键名写错了"，而是**四处各写一遍**（core-ts engine / gui providers /
 * shared ipc / gateway-ts llmGateway），没有任何一方会抱怨；改键名时静默失效。
 * 主进程产物未 minify，core-ts/src/local_models.ts 被原样 bundle 进来，
 * 所以这份"唯一产地"在产物里的**代码**形态就是 `"_local_models"` 字面量恰好 1 次
 * （= `export const LOCAL_MODELS_KEY` 那一行）。多出任何 1 次即说明有人又就地重写。
 * 已用变异测试验红：把 providers.ts 里改回字面量 → 计数变 2 → MISS。 */
checkCount("main", main, '"_local_models"', 1, "清单键名在产物里只有 1 处产地（常量定义本身）");
/* GUI 侧必须**委托**给共享实现，而不是就地过滤。
 * ⚠️ 这里曾经用过 `function localModelSpecs(` 计数（期望 1）—— 变异测试当场证伪：
 *   在 providers.ts 里另写一份同名实现并去掉 import，产物里计数**仍是 1**
 *   （core-ts 那份没人引用 → 被 tree-shake 掉，是**替换**不是**新增**）。
 *   = 又一条"计数通过但锁错对象"的断言。结论：**定义数量在产物层不可观测**
 *   （模块边界已被摊平），"唯一实现"这个性质只能靠源码级守卫守
 *   （tests/core-ts/a1024-guards.spec.ts ②-3/②-5）。产物层只留**能真正区分**的形态：
 *   键名字面量的产地计数（上方）+ 入口的委托调用（下方）。两条均已变异验红。 */
check("main", main, "return localModelSpecs(loadTable())", "GUI 清单入口委托给共享实现（不就地过滤）");

/* A-1040：记忆「存储位置」= 一个自定义根目录同时决定 memory.json 与向量库。
 * 病根不是"两个地址显示得不好看"，而是**向量库被写死钉在默认 data/**（`// LanceDB 保持原位`）
 * + 主进程**返回字符串模板** `resolve(PROJECT_ROOT, "data", "<agentId>", "lancedb")`
 * —— 后者是字面 `<agentId>` 的假路径，用户拿到也没法用，且永不随设置变化。
 * 这里只锁"产物层可观测"的事实：推导被真正引用（否则会被 tree-shake）、迁移留痕在、
 * 旧假模板彻底不在。行为面（两者同根 / 迁移搬数据）由 tests/core-ts/a1040-guards.spec.ts
 * 真跑 MemoryStore 锁定，变异 13 条全红。 */
check("main", main, "resolveMemoryPaths", "记忆位置推导的唯一实现进了产物（configGet 真的引用它）");
check("main", main, "向量库已迁移", "旧向量库迁移留痕进了产物（改根目录不会静默丢向量）");
check("main", main, "向量库迁移失败", "迁移失败必须出声（不留静默失败）");
checkAbsent("main", main, '"<agentId>"', "字面 <agentId> 的假路径模板未进产物（旧假信息已彻底移除）");
check("renderer", renderer, "恢复默认位置", "「恢复默认位置」出口进了渲染产物（自定义根不是单向门）");
check("renderer", renderer, "（先选择 Agent）", "没有目标 Agent 时如实提示进了渲染产物（不再编路径）");

/* A-1041：安装包 1GB 的元凶 —— `out/main/chunks/lancedb.win32-x64-msvc-*.node`（297MB）。
 * 病根是 store.ts 里 `/* @vite-ignore *\/` 让 vite 跳过 alias，把真包连同原生子包解析进 bundle；
 * 而 electron-builder 的 `files` 里根本没有 node_modules —— 这份 297MB 只活在 bundle 里，
 * 既不好管理也没法裁剪。现在改为「构建期桩 + 运行期按内嵌组件目录 require」。
 *
 * 产物层能真正区分的事实（缺一个就说明又打回去了）：
 *   ① 产物里没有原生 .node —— 这是最直接的体积证据，改回去必然重新出现；
 *   ② 整个 out/main 体积有上界 —— 光看 ① 抓不到"换了个名字的原生包"；
 *   ③ 真包指纹（`lancedb-win32-x64-msvc`）不在主进程产物里；
 *   ④ 桩的两端都在产物里：组件目录契约（找得到）+ 未就位报错（如实告知）。
 * 行为面（注入分支先于回退、组件未就位不静默降级）由 tests/gui/a1041-guards.spec.ts
 * 与 gui/scripts/mut-a1041-bundle.mjs（15 条变异全红）锁定。 */
const mainJs = readAll("out/main", [".js"]);
const mainBytes = mainJs.reduce((n, p) => n + statSync(p).size, 0);
const mainMb = mainBytes / 1024 / 1024;
const nativeAll = readAll("out", [".node"]);
if (nativeAll.length > 0) {
  fail++;
  console.log(`MISS [main] 产物里不得有原生 .node（297MB 回来的信号）：${nativeAll.join(", ")}`);
} else {
  console.log("OK   [main] 产物里没有原生 .node（LanceDB 的 297MB 已移出默认安装包）");
}
// 上界取 10MB：合法产物 ≈ 2.9MB，留足增长空间，但离 288MB 差两个数量级。
if (mainMb > 10) {
  fail++;
  console.log(`MISS [main] out/main 体积上界（实测 ${mainMb.toFixed(2)}MB，上限 10MB）`);
} else {
  console.log(`OK   [main] out/main 体积上界（实测 ${mainMb.toFixed(2)}MB，上限 10MB）`);
}
checkAbsent("main", main, "lancedb-win32-x64-msvc", "真实原生子包的名字未进产物（打进去就说明 alias 又失效）");
check("main", main, "components/lancedb", "内嵌组件目录契约进了产物（运行时按此目录找真实包）");
check("main", main, "LanceDB 运行时组件未就位", "组件未就位时的如实报错进了产物（不静默降级）");
check("renderer", renderer, "向量记忆已降级为 JSON 检索", "降级说明进了渲染产物（用户不会只看到「没结果」）");
check("renderer", renderer, "prepare-lancedb-component.mjs", "组件生成脚本提示进了渲染产物（用户知道怎么补）");

console.log(fail === 0 ? "\nALL ASSERTIONS PASSED" : `\n${fail} ASSERTION(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
