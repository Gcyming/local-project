#!/usr/bin/env node
/**
 * scripts/contract-check.mjs — 契约测试本地硬门槛（无 CI 替代）。
 * 串行执行（任一步失败即退出非 0）：
 *   ① 生成物无漂移（py scripts/gen_contracts.py --check）
 *   ② pydantic 导入 + 假数据校验（pytest tests/test_contract.py）
 *   ③ zod 假数据校验（vitest tests/core-ts/contract.spec.ts）
 * 入口：pnpm run contract:check
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(label, cmd, args) {
  console.log(`\n[contract:check] ${label}...`);
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
    console.log(`[contract:check] ${label} PASS`);
    return true;
  } catch (e) {
    console.error(`[contract:check] ${label} FAIL`);
    process.exitCode = 1;
    return false;
  }
}

const steps = [
  ["① 生成物无漂移", "py", ["scripts/gen_contracts.py", "--check"]],
  ["② pydantic 假数据校验", "py", ["-m", "pytest", "tests/test_contract.py", "-q"]],
  // ③ 直跑 vitest 二进制（pnpm 包装在非 TTY 下吞输出并返回非 0，诊断确认后绕开）
  ["③ zod 假数据校验", "node", ["node_modules/vitest/vitest.mjs", "run", "tests/core-ts/contract.spec.ts"]],
];

for (const [label, cmd, args] of steps) {
  if (!run(label, cmd, args)) {
    break;
  }
}

if (process.exitCode) {
  console.error("\n[contract:check] 契约校验未通过（dev/build 拒绝启动）");
} else {
  console.log("\n[contract:check] 契约校验全过（双端一致，无漂移）");
}