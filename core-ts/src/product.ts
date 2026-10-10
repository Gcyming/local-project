/**
 * core-ts/src/product.ts —— 产品身份的**单一产地**。
 *
 * 为什么要有这个文件：slime 以前对外发请求时**没有一致的产品标识**——模型请求是「无身份」的，
 * 搜索流量挂了个半伪装的 UA，各处散落着 `slime-agent` / `slime-gui` / `SlimeMiniBot` 三种写法。
 * 事实写在多个地方，就必然漂移。这里把「产品叫什么、什么版本」收成一处，其余通道全部引它。
 *
 * ⚠️ **版本号为什么不运行时读 package.json**：
 * 运行时 fs 读取会把「一次打包出来的东西」变成「运行期碰运气看盘上写着什么」——
 * 打包路径/`asar`/`node_modules` 布局一变就读不到，且读不到时还要决定回落成什么（又是一个静默事实）。
 * 所以这里写死常量，靠 `tests/core-ts/product.spec.ts` 的守卫断言它与根`package.json` 的
 * `version` **逐字相等**：写N 处的老问题不能根治，但**漂移会被CI 立刻打红**，这就够了。
 *改版本时只改两处（package.json 与此），守卫会盯着你。
 */

/** 产品名（对外标识用，小写、无空格）。 */
export const PRODUCT_NAME = "slime";

/**
 * 产品版本。**必须与根`package.json` 的 `version` 逐字一致**，
 * 由 `tests/core-ts/product.spec.ts` 守卫断言。
 */
export const PRODUCT_VERSION = "0.1.0";

/**
 * 「申请类」对外请求的诚实标识，形如 `slime/0.0.8`。
 *
 * 用于**模型 API、更新检查、市场拉取**这类「向服务方申请资源」的流量——
 * 这些请求本来就带着鉴权凭据，藏身份毫无意义，标清楚反而便于对方定位与限流。
 *
 * ⚠️ **不要用在网页抓取上**。搜索引擎/爬虫要的是「像浏览器」，不是「像 slime」，
 * 那边用 `websearch/crawler.ts` 与 `search/onlineSearch.ts` 里的浏览器 UA，两套策略别混。
 */
export function productUserAgent(): string {
  return `${PRODUCT_NAME}/${PRODUCT_VERSION}`;
}
