/**
 * A-1034 守卫：构建版三问题的回归护栏。
 *
 * 覆盖四块**曾经静默失效**的地方：
 *   ① 系统可执行文件不能再裸命令名 spawn（"系统自带" ≠ "在 PATH 里" → ENOENT）
 *   ② 解压不能再依赖外部 tar/unzip（改用 zip.ts），且必须挡住 Zip-Slip
 *   ③ Office 文档要能抽出正文；旧版二进制要**明确拒绝**而不是吐乱码
 *   ④ 改动 diff 必须随思考记录落盘，重新打开会话仍展得开（此前只写工具名 → 永久丢失）
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isZip, listZip, readZipText, extractZipTo, zipEntryNames } from "../../core-ts/src/zip.js";
import { extractDocText, docKindFromExt, legacyBinaryName } from "../../core-ts/src/doc_text.js";
import { resolvePowerShellExe } from "../../core-ts/src/screen/backends/desktop.js";
import { composeToolCallBlock, diffTagForTrace } from "../../core-ts/src/services/chat.js";
import { splitTraceDiff, traceEntriesToToolSteps, TRACE_DIFF_TRIMMED_MARKER } from "../../gui/src/renderer/pages/thinkingText.js";

const ROOT = resolve(__dirname, "../..");
const FIX = join(ROOT, "tests/fixtures/office");
const readFileText = (p: string) => readFileSync(p, "utf8");
const readFileBuf = (p: string) => readFileSync(p);

describe("A-1034 ① 系统可执行文件用绝对路径（不再是裸命令名）", () => {
  it("resolvePowerShellExe 在 Windows 上解析出存在的绝对路径，且记录了候选序列", () => {
    const r = resolvePowerShellExe();
    // 候选序列必须非空 —— 否则失败提示里将无从说明"试过哪些路径"
    expect(r.tried.length).toBeGreaterThan(0);
    if (process.platform === "win32") {
      // 裸名只应出现在"全部候选都不存在"的兜底路径上
      const isBare = r.exe === "powershell.exe";
      expect(isBare || existsSync(r.exe), `解析结果既不是已存在的文件也不是裸名兜底: ${r.exe}`).toBe(true);
      if (!isBare) {
        expect(r.exe.toLowerCase()).toMatch(/powershell\.exe$|pwsh\.exe$/);
        expect(r.exe).toMatch(/^[a-zA-Z]:[\\/]/);  // 绝对路径
      }
    }
  });

  it("系统工具目录解析：System32 存在时必须是绝对路径（不是裸名）", () => {
    // 断言的是**行为契约**：能解析到就不允许回退裸名
    const r = resolvePowerShellExe();
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    if (process.platform === "win32" && existsSync(join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))) {
      expect(r.exe).not.toBe("powershell.exe");
    }
  });

  it("屏幕宿主模板用 @() 强制数组（否则单窗口会被折叠成对象 → 静默变空列表）", () => {
    const src = readFileText(join(ROOT, "core-ts/src/screen/backends/desktop.ts"));
    /* A-1061⑨ 迁移：windows 分支现在**内联枚举并带诊断**（空列表要说清为什么），
       但「数组不被折叠」这条不变量必须仍然成立 —— 两个集合初始化都必须是 @()：
       $procs（候选）与 $list（输出）。 */
    expect(src.includes("$procs = @(Get-Process")).toBe(true);
    expect(src.includes("$list = @()")).toBe(true);
    expect(src.includes("windows = $list;")).toBe(true);
  });

  it("屏幕宿主**调用点**必须用解析结果（函数写对了但调用点硬编码裸名 = 白写）", () => {
    // 这条是"接线守卫"：`resolvePowerShellExe` 自己测过了，但若 spawn 处写死裸名，
    // 解析函数再正确也不生效 —— 变异 M10 就是从调用点下手的。
    const src = readFileText(join(ROOT, "core-ts/src/screen/backends/desktop.ts"));
    expect(src.includes("const host = resolvePowerShellExe();")).toBe(true);
    expect(/spawn\(\s*"powershell\.exe"/.test(src)).toBe(false);
  });

  it("构建脚本不再直接 exec(\"tar\")（走 systemExe 绝对路径解析）", () => {
    const src = readFileText(join(ROOT, "scripts/prepare-runtime.mjs"));
    // 原意图：不得裸调外部命令，必须经绝对路径解析。A-1036 起解析改成**懒求值**
    // （`const TAR = …` 写在 isWindows 声明之前会命中 TDZ），所以这里断"有没有解析"而不是"哪种写法"。
    expect(src.includes('exec("tar"')).toBe(false);
    expect(src).toMatch(/function systemExe\(/);
    expect(src).toMatch(/exec\(tarExe\(\),/);
  });

  it("adb 解压不再调用外部命令，改用内置 zip 模块", () => {
    const src = readFileText(join(ROOT, "gui/src/main/adb.ts"));
    expect(src.includes("extractZipTo")).toBe(true);
    expect(src.includes('"tar"')).toBe(false);
    expect(src.includes('"unzip"')).toBe(false);
  });
});

describe("A-1034 ② zip 解析与解压安全", () => {
  it("能解析真实容器：docx 样例的条目与部件可读", () => {
    const buf = readFileBuf(join(FIX, "sample.docx"));
    expect(isZip(buf)).toBe(true);
    const names = zipEntryNames(buf);
    expect(names).toContain("word/document.xml");
    expect(readZipText(buf, "word/document.xml")).toContain("Slime 文档读取测试");
  });

  it("非 ZIP 输入明确抛错（不猜、不静默返回空）", () => {
    expect(isZip(Buffer.from("这不是 zip"))).toBe(false);
    expect(() => listZip(Buffer.from("这不是 zip"))).toThrow(/不是 ZIP 容器/);
  });

  it("PK 头但结构损坏（无 EOCD）→ 明确报错", () => {
    const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0)]);
    expect(() => listZip(fake)).toThrow(/ZIP 结构损坏/);
  });

  it("Zip-Slip：逃逸条目被拒并计入 skipped，解压目录外不得落盘", async () => {
    const buf = readFileBuf(join(FIX, "evil.zip"));
    // ⚠️ 用自己的**父目录**当"解压目录之外"，不要用系统 temp 根：
    // 逃逸成功时文件会落在父目录里，用共享的 temp 根会污染机器上其它测试/进程，
    // 且残留文件会让下一次运行**误判**（A-1034 实测：变异运行的残留导致假红）。
    const parent = mkdtempSync(join(tmpdir(), "slime-zipslip-"));
    const dest = join(parent, "dest");
    try {
      mkdirSync(dest, { recursive: true });
      const r = await extractZipTo(buf, dest);
      expect(r.skipped.length).toBe(3);
      for (const bad of ["escape.txt", "escape2.txt", "abs-escape.txt"]) {
        expect(existsSync(join(dest, bad)), `不应写入解压目录内: ${bad}`).toBe(false);
        expect(existsSync(join(parent, bad)), `不应逃逸到解压目录外: ${bad}`).toBe(false);
      }
      expect(existsSync(join(dest, "ok", "inside.txt"))).toBe(true);
      expect(r.files).toBe(1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  /**
   * A-1038：解压进度回调（async 化 + 逐条目上报）。
   *
   * 这几条同时钉住三件容易回退的事：
   *   ① 版本 A-1034 里 `extractZipTo` 是同步的 —— 若有人改回去，`await` 拿到的是函数而非结果，
   *      下面的字段断言会立刻红（而不是"进度条不刷新"这种只能靠用户发现的静默失效）。
   *   ② `total` 必须**含被拒条目**：否则含 Zip-Slip 的包进度永远到不了 100%（卡在 75%）。
   *   ③ 最后一条回调必须 `current === ""`（收尾信号），调用方据此判定"真跑完了"。
   */
  it("解压进度：逐条目上报，末条为收尾信号，且被拒条目也计入 total", async () => {
    const buf = readFileBuf(join(FIX, "evil.zip"));
    const parent = mkdtempSync(join(tmpdir(), "slime-zipprog-"));
    const dest = join(parent, "dest");
    try {
      const ticks: Array<{ processed: number; total: number; files: number; current: string }> = [];
      const r = await extractZipTo(buf, dest, { onProgress: (p) => ticks.push({ ...p }) });
      // 4 个非目录条目（3 个逃逸 + 1 个正常）→ total 必须是 4 而不是 1
      expect(ticks.length).toBeGreaterThan(0);
      expect(ticks[ticks.length - 1].total).toBe(4);
      // processed 单调递增到 total（含被拒的 3 个）
      expect(ticks[ticks.length - 1].processed).toBe(4);
      expect(ticks.map((t) => t.processed)).toEqual([...ticks.map((t) => t.processed)].sort((a, b) => a - b));
      // files 只数真正落盘的
      expect(ticks[ticks.length - 1].files).toBe(1);
      expect(ticks[ticks.length - 1].files).toBe(r.files);
      // 末条为收尾信号
      expect(ticks[ticks.length - 1].current).toBe("");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("A-1034 ③ Office 文档提取", () => {
  it("docx：段落 + 表格行 + XML 实体还原", () => {
    const r = extractDocText(readFileBuf(join(FIX, "sample.docx")), "docx");
    expect(r.text).toContain("Slime 文档读取测试");
    expect(r.text).toContain("姓名 | 分数");
    expect(r.text).toContain("<标签>");      // &lt;标签&gt; 必须还原，不能留实体
    expect(r.info.join()).toContain("表格");
  });

  it("pptx：按页分节，页序正确", () => {
    const r = extractDocText(readFileBuf(join(FIX, "sample.pptx")), "pptx");
    expect(r.text).toContain("--- 第 1 页 ---");
    expect(r.text).toContain("--- 第 2 页 ---");
    expect(r.text.indexOf("第 1 页")).toBeLessThan(r.text.indexOf("第 2 页"));
  });

  it("xlsx：共享串 / 内联串 / 列跳位 / 多表", () => {
    const r = extractDocText(readFileBuf(join(FIX, "sample.xlsx")), "xlsx");
    expect(r.text).toContain("月份 | 销量");   // 共享串
    expect(r.text).toContain("内联字符串");     // inlineStr
    expect(r.text).toContain("123");          // 数字单元格（C2，跨列跳位）
    expect(r.text).toContain("表：汇总");      // 第二张表
  });

  it("扩展名分派：宏/模板变体也认，非文档返回 null", () => {
    expect(docKindFromExt(".DOCX")).toBe("docx");
    expect(docKindFromExt(".xlsm")).toBe("xlsx");
    expect(docKindFromExt(".pptm")).toBe("pptx");
    expect(docKindFromExt(".txt")).toBeNull();
  });

  it("旧版二进制格式：识别得出，且提取时明确拒绝而不是吐乱码", () => {
    expect(legacyBinaryName(".xls")).toBe("Excel 97-2003");
    expect(legacyBinaryName(".docx")).toBeNull();
    // OLE2 复合文档头（真 .doc/.xls/.ppt 都长这样）
    const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64, 0)]);
    expect(() => extractDocText(ole2, "xlsx")).toThrow(/不是有效的 Office 2007\+ 文档/);
  });
});

describe("A-1034 ④ 改动 diff 随思考记录落盘与还原", () => {
  // 真实标记形如 [__slime_diff__]base64(old)|base64(new)[/__slime_diff__] —— 中间的 `|` 是必需分隔符
  const realTag = "[__slime_diff__]b2xkYm9keQ==|bmV3Ym9keQ==[/__slime_diff__]";

  it("composeToolCallBlock：diff 标记附在对应行尾（按下标对齐）", () => {
    const block = composeToolCallBlock(["file_write", "file_read"], [realTag, undefined]);
    const lines = block.split("\n");
    expect(lines[0]).toBe("### 工具调用记录");
    expect(lines[1].endsWith(realTag)).toBe(true);
    expect(lines[2].includes("__slime_diff__")).toBe(false);   // 无标记的行不许凭空多出来
  });

  it("composeToolCallBlock：不传 diffTags 时行为与旧版一致（只写工具名）", () => {
    const block = composeToolCallBlock(["file_read"]);
    expect(block).toBe("### 工具调用记录\n- ⟳ 读取文件");
  });

  it("diffTagForTrace：无标记 → undefined；有标记 → 原样返回", () => {
    expect(diffTagForTrace(undefined)).toBeUndefined();
    expect(diffTagForTrace("已保存 12 字节")).toBeUndefined();
    expect(diffTagForTrace(`已保存 12 字节\n${realTag}`)).toBe(realTag);
  });

  it("diffTagForTrace：超限写 trimmed 占位，而不是静默什么都不写（阈值边界两侧都测）", () => {
    // 阈值 60000 源码字符 → 闸门是 tag.length > 60000 × 1.4 = 84000
    const makeTag = (n: number) => `[__slime_diff__]${"A".repeat(n)}|${"B".repeat(n)}[/__slime_diff__]`;
    const justUnder = makeTag(Math.floor((84_000 - 40) / 2));
    const justOver = makeTag(Math.ceil((84_000 + 40) / 2));
    expect(diffTagForTrace(justUnder)).toBe(justUnder);                       // 未超限：原样保留
    expect(diffTagForTrace(justOver)).toBe(TRACE_DIFF_TRIMMED_MARKER);        // 超限：可见降级
  });

  it("composeToolCallBlock：trimmed 占位会真的写进对应行", () => {
    const block = composeToolCallBlock(["file_write"], [TRACE_DIFF_TRIMMED_MARKER]);
    expect(block.includes(TRACE_DIFF_TRIMMED_MARKER)).toBe(true);
  });

  it("splitTraceDiff：把机器标记拆成 result，正文不留 base64", () => {
    const { text, result, diffTrimmed } = splitTraceDiff(`写入文件 ${realTag}`);
    expect(text).toBe("写入文件");
    expect(result).toBe(realTag);
    expect(diffTrimmed).toBeUndefined();
    expect(text.includes("__slime_diff__")).toBe(false);
  });

  it("splitTraceDiff：trimmed 占位单独成档（不冒充成完整 diff）", () => {
    const r = splitTraceDiff(`写入文件 ${TRACE_DIFF_TRIMMED_MARKER}`);
    expect(r.result).toBeUndefined();
    expect(r.diffTrimmed).toBe(true);
    expect(r.text).toBe("写入文件");
  });

  it("traceEntriesToToolSteps：带标记的条目仍能与真实时间线去重（标记不参与比对）", () => {
    const lookup = (e: string) => (e.includes("写入文件") ? { name: "file_write", label: "写入文件" } : null);
    // 时间线里已有同名节点 → 该条目应被消费掉（不重复出节点），
    // 若实现里拿"带标记的原文"去比对就永远匹配不上，历史回看会多出一行
    const out = traceEntriesToToolSteps([`写入文件 ${realTag}`], lookup, [{ name: "file_write", label: "写入文件" }]);
    expect(out.length).toBe(0);
  });

  it("traceEntriesToToolSteps：未命中的条目带出 result（历史回看才展得开 diff）", () => {
    const lookup = (e: string) => (e.includes("写入文件") ? { name: "file_write", label: "写入文件" } : null);
    const out = traceEntriesToToolSteps([`写入文件 ${realTag}`], lookup, []);
    expect(out.length).toBe(1);
    expect(out[0].result).toBe(realTag);
    expect(out[0].label).toBe("写入文件");
  });

  it("ChatPanel 的时间线映射必须带上 result（丢掉它就等于历史永远没有 diff）", () => {
    const src = readFileText(join(ROOT, "gui/src/renderer/pages/ChatPanel.tsx"));
    const m = /tracedTools\.map\(\(t\) => \(([\s\S]{0,200}?)\)\)/.exec(src);
    expect(m, "找不到 tracedTools 的映射表达式").not.toBeNull();
    expect(m![1].includes("result: t.result")).toBe(true);
  });

  it("[反例] 上一段的正则必须真的能抓到「只映射 name/label」的坏写法（守卫自检）", () => {
    const bad = "...tracedTools.map((t) => ({ kind: \"tool\" as const, name: t.name, label: t.label }))";
    const m = /tracedTools\.map\(\(t\) => \(([\s\S]{0,200}?)\)\)/.exec(bad);
    expect(m).not.toBeNull();
    expect(m![1].includes("result: t.result")).toBe(false);
  });

  it("core-ts 侧必须把 diff 一起写进留痕（否则落盘的那一份根本没有标记）", () => {
    const src = readFileText(join(ROOT, "core-ts/src/services/chat.ts"));
    expect(src.includes("reasoningToolDiffTags")).toBe(true);
    expect(src.includes("composeToolCallBlock(reasoningToolNames, reasoningToolDiffTags)")).toBe(true);
    expect(src.includes("diffTagForTrace(chunk.result)")).toBe(true);
  });

  it("确认 reasoning 不回灌上游上下文（否则 base64 会毒化上下文，本方案不成立）", () => {
    // 前提性断言：一旦有人把 reasoning 塞进上游 messages，本设计需要重新评估
    const src = readFileText(join(ROOT, "gui/src/main/index.ts"));
    expect(src.includes('{ role: "assistant" as const, content: r.ai }')).toBe(true);
  });
});
