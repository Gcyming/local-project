# slime 内嵌浏览器：广告拦截调研与落地方案（A-1018）

> 结论先行：**广告拦截必须做在"请求发出之前"的网络层**，规则来自社区过滤列表。
> slime 已按此落地：主进程在 `persist:slime-browser` 分区上拦截（`gui/src/main/adblock.ts`），默认开启。

## 一、各家是怎么做的（调研）

| 主体 | 拦截位置 | 规则来源 | 备注 |
|---|---|---|---|
| Chrome / Edge 扩展（uBlock Origin 等） | 浏览器扩展钩子（`webRequest` / Manifest V3 的 `declarativeNetRequest`） | EasyList / EasyPrivacy 等社区列表，定期自动更新 | 核心机制 = **观察请求 → 放行 / 重定向 / 取消**；取消后浏览器就当这个资源不存在 |
| Firefox 内置跟踪保护 | 引擎内建 | Disconnect 名单 | 只挡跟踪器，不挡一般广告 |
| Safari 内容拦截器 | 交给系统编译规则 | 扩展提供的规则集 | 规则预编译成二进制，性能好 |
| Electron 应用（= slime 的形态） | 主进程 `session.webRequest.onBeforeRequest` | 同上，自己加载 | **官方 API**，按 session 生效 |

**关键事实（一手来源）**：
- Electron 官方 `webRequest.onBeforeRequest`：主进程、按 session 生效；listener 收到
  `details{ url, resourceType, referrer, frame, … }`，`callback({ cancel: true })` 即拦截。
  ⚠️ 官方原文明确 **"Only the last attached listener will be used"** —— 同一事件只保留最后一个监听器，
  所以必须**只注册一次**（`adblock.ts` 用 `installed` 标记保证幂等；分头注册会把前一个静默顶掉）。
- EasyList 过滤语法（社区通用）：
  - `||exampleadnetwork.com^` —— 阻塞该域及其子域
  - `/banner[0-9]+\.jpg$` —— 阻塞匹配路径
  - `@@||trustedpartner.com^$script` —— 白名单例外
  - `$third-party` / `$script` 等修饰符限定范围

## 二、slime 的落地方案（已实现）

**位置**：`gui/src/main/adblock.ts`，在 app ready 时对该分区装一次拦截器：

```ts
installAdBlocker(session.fromPartition("persist:slime-browser"), PROJECT_ROOT);
```

- **只作用于内嵌浏览器**：装在 `persist:slime-browser` 分区，不动 `defaultSession`，
  所以主进程自身的请求（模型调用、更新检查）不受影响。
- **规则**：内置一份**保守**的高频广告/跟踪域（doubleclick / googlesyndication / criteo /
  taboola / outbrain / scorecardresearch …），加上用户在 `config/adblock/*.txt` 放任意
  EasyList 派生列表（按 `||host^` / `@@` / 纯域名行 / 注释解析）。
- **开关**：`config/adblock/settings.json` 的 `enabled`（缺省开启；首次运行自动落一份带说明的默认文件）。
  关闭时**不安装**监听器（不是"装了但放行"—— 少一层容器开销）。
- **可观测**：`adblockStats()` 暴露 `{blocked, rules, enabled}`，启动日志会打印规则条数，
  拦截真的发生了能看见，而不是只写一个开关自述。

## 三、诚实交代边界（v1 ≠ uBlock Origin）

1. **没有内置完整 EasyList**。那是一份数十万行、需定期更新、带完整修饰符与正则引擎的工程。
   本版实现的是**核心子集**：域名锚定阻塞（覆盖绝大多数广告/跟踪域）+ 例外。
   路径型规则（`/ads/*.gif`）与 `$third-party` 这类修饰符**本版不解析也不假装解析**
   （见 `parseRules` 只认域名形态，其余形态直接忽略）—— 宁可少挡，不做假承诺。
2. **不做 cosmetic filtering**（页面内元素隐藏，uBlock 的"元素隐藏规则"那一半）。
   本版只做网络层，因此"广告位留白"会存在，但广告内容不会加载。
3. **规则不会自动更新**。想要更全的覆盖：把 EasyList 的域名形态导出成 txt 放进
   `config/adblock/`（后续可以加一个"从上游拉取并转换"的任务）。
4. **误杀风险**：内置列表只放"几乎不可能是正常内容服务"的域，不塞 `ads` / `track` 这类裸词。

## 四、后续可做（未做）

- 定时从 EasyList 上游拉取并转成本地 txt（带版本与校验）。
- 面板上给一个开关 + 显示 `adblockStats()` 的拦截计数。
- 更完整的 ABP 引擎（修饰符、正则、元素隐藏）。
