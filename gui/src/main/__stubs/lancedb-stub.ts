/**
 * A-966：@lancedb/lancedb 原生 .node 无法被 rollup 当 JS 打包（清缓存全量 bundle 时必现 `\0` 解析错），
 * 而桌面端默认 `[memory.lancedb] enabled=false`，GUI 主进程不会真正连接 LanceDB。
 * 此 stub 仅用于让 electron-vite main bundle 内联通过；若未来桌面端启用向量记忆，
 * 应去掉 `vite.config.ts` 的 alias 并改走「外部依赖 + asarUnpack」加载原生包。
 */
export function connect(): { table: () => never } {
  // 惰性抛错：只有真正尝试建表/写入时才失败（构造阶段调用 connect 不会崩）
  throw new Error("LanceDB 未在桌面端启用（[memory.lancedb] enabled=false）");
}
export type Table = unknown;