import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  getGlobalIndex, globalIndexKey, resetGlobalIndex,
} from "../../core-ts/src/memory/global.js";

const tmpDirs: string[] = [];

function makeRoot(): string {
  const raw = mkdtempSync(join(tmpdir(), "memkey-"));
  tmpDirs.push(raw);
  if (process.platform === "win32" && /^[a-z]:/.test(raw)) {
    const upper = raw[0].toUpperCase() + raw.slice(1);
    tmpDirs.push(upper);
    return upper;
  }
  return raw;
}

function spellings(root: string): string[] {
  const out = [root, root + sep + "zz" + sep + "..", root + sep + ".", root + sep];
  if (process.platform === "win32") {
    const fwd = root.replace(/\\/g, "/");
    out.push(fwd, fwd + "/", fwd + "/zz/../", root[0].toLowerCase() + root.slice(1));
  }
  return out;
}

afterEach(() => resetGlobalIndex());
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("全局索引单例 key 的跨语言归一化", () => {
  it("同一目录的多种写法归一化到同一个 key（与 Python 侧 str(Path(base_dir).resolve()) 逐字相同）", () => {
    const root = makeRoot();
    for (const spelling of spellings(root)) {
      expect(globalIndexKey(spelling)).toBe(root);
    }
    expect(globalIndexKey("")).toBe("");
  });

  it("同一目录的多种写法取到同一个索引单例", () => {
    const root = makeRoot();
    const canonical = getGlobalIndex(root);
    for (const spelling of spellings(root)) {
      expect(getGlobalIndex(spelling)).toBe(canonical);
    }
  });

  it("一种写法写入的条目，另一种写法立即读得到（同一份内存态，不是两份陈旧副本）", () => {
    const root = makeRoot();
    const back = getGlobalIndex(root);
    const other = getGlobalIndex(root + sep + "zz" + sep + "..");
    back.upsert("跨语言全局去重索引必须共用一份内存态", "xlang_a", "m1");
    rmSync(join(root, ".global", "index.json"), { force: true });
    const seen = other.lookup("跨语言全局去重索引必须共用一份内存态");
    expect(seen).not.toBeNull();
    expect(seen?.agent).toBe("xlang_a");
    expect(seen?.memId).toBe("m1");
  });

  it("不同目录仍然拿到不同单例（归一化不得过度合并）", () => {
    const one = makeRoot();
    const two = makeRoot();
    expect(globalIndexKey(one)).not.toBe(globalIndexKey(two));
    expect(getGlobalIndex(one)).not.toBe(getGlobalIndex(two));
    expect(getGlobalIndex(one + sep + "zz" + sep + "..")).toBe(getGlobalIndex(one));
    expect(getGlobalIndex(two + sep + "zz" + sep + "..")).toBe(getGlobalIndex(two));
  });

  it("resetGlobalIndex() 清掉进程内单例，同一目录重新取到新实例", () => {
    const root = makeRoot();
    const first = getGlobalIndex(root);
    resetGlobalIndex();
    const second = getGlobalIndex(root);
    expect(second).not.toBe(first);
    expect(second).toBe(getGlobalIndex(root + sep + "zz" + sep + ".."));
  });
});
