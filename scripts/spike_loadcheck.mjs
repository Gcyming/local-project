/**
 * scripts/spike_loadcheck.mjs — 向量存储 spike 依赖加载探测（Windows 兼容性验证）。
 * 验证 @lancedb/lancedb + better-sqlite3 能否在 Windows 原生加载即跑通。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

async function main() {
  // 1. better-sqlite3
  try {
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, vec BLOB)");
    db.prepare("INSERT INTO t (vec) VALUES (?)").run(Buffer.from([1, 2, 3]));
    const row = db.prepare("SELECT vec FROM t").get();
    console.log("[PASS] better-sqlite3: 加载+读写 OK", row.vec.length, "bytes");
    db.close();
  } catch (e) {
    console.log("[FAIL] better-sqlite3:", e.message);
  }

  // 2. @lancedb/lancedb
  try {
    const lancedb = await import("@lancedb/lancedb");
    const { open, connect } = lancedb;
    console.log("[INFO] @lancedb/lancedb 导出:", Object.keys(lancedb).slice(0, 8).join(","));
    const db = await connect("memory://");
    const tbl = await db.createTable("t", [{ id: 1, vec: [1, 2, 3], text: "hello" }]);
    const rows = await tbl.query().limit(1).toArray();
    console.log("[PASS] @lancedb/lancedb: memory:// 建表+查询 OK", rows.length, "行");
  } catch (e) {
    console.log("[FAIL] @lancedb/lancedb:", e.message);
  }
}

main().then(() => process.exit(0));