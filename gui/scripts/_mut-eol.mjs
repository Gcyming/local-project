/**
 * gui/scripts/_mut-eol.mjs — 变异脚本的**行尾自适应**与**行尾自检**（唯一实现，共享）。
 *
 * 为什么单独抽一个模块（而不是每条脚本各写一份）：
 *   这条纪律在 `ref-engineering §15①` 里**早就写过**，`mut-a1046` / `mut-a1047` 也各自实现在
 *   自己脚本里 —— 但新脚本是从**别的脚本**抄模板的，抄到的那份恰好没有（`mut-a1056.mjs`
 *   因为没有多行锚点所以没带 helper）→ 坑被原样复制：`mut-a1055.mjs` 首轮
 *   **4 条多行锚点静默未命中**。
 *   **⇒ 规则写在文档里会被漏；写进"被复制的样板"才漏不掉。现在样板就是本模块。**
 *
 * ⚠️ **同一个仓库里行尾是混的**，别信"本项目是 CRLF / 是 LF"这种整体印象 ——
 *   实测（2026-09-21，A-1055）：`updater.ts` / `StatusPanel.tsx` / `preload/index.ts` 是 **CRLF**，
 *   而 `index.ts` / `ipc.ts` / `notify.ts` / `ChatPanel.tsx` 是 **LF**。
 *   要复判请**跑命令**，不要回忆：
 *
 *     node -e 'const fs=require("fs");for(const f of process.argv.slice(1)){const s=fs.readFileSync(f,"utf8");const c=(s.match(/\r\n/g)||[]).length, l=(s.match(/(?<!\r)\n/g)||[]).length;console.log(c===0?"LF":(l===0?"CRLF":"MIXED"),f)}' <file...>
 *
 *   （`git diff` 的 "LF will be replaced by CRLF" 警告**不能**当判据 —— 它说的是 index/checkout
 *   规范化，不是工作区的当前字节。）
 */

import { readFileSync } from "node:fs";

/** 正则转义（供把字面量拼进 RegExp 用） */
export const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 该文件的**主导**行尾：出现 `\r\n` 就按 CRLF 处理 */
export const nlOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

/**
 * **行尾无关的**单次替换（单行 / 多行都走这一个）。
 *
 * 单行锚点：退化成普通的 `includes` + `replace`（行为与旧的 `sub` 完全一致）。
 * 多行锚点（`from` 含 `\n`）：把 `from` 的行间换成 `\r?\n`、`to` 的行间换成**该文件自己的**
 *   行尾，于是目标文件是 LF 还是 CRLF 都命中，且**不会**把 LF 塞进 CRLF 文件。
 *
 * 为什么把它做成"默认就好用"的形态（而不是要求每条锚点记得换成 `subLines`）：
 *   实测 `mut-a1054.mjs` 里有 **10 条**多行锚点写成裸 `"...\n..."` —— 它们当时"能用"仅仅
 *   因为目标文件恰好是 LF。行尾一翻就**静默失效**（守卫仍绿，实际一个字没改）。
 *   要求人逐条记得换，就是要求人不犯错；把函数做成行尾无关，才是结构上消除。
 *   **⇒ 新脚本一律直接 `import { sub }` 用本函数，不要自己再写一个。**
 *
 * ⚠️ `to` 走**替换函数**而不是替换字符串：替换字符串里的 `$&` / `$1` / `` $` `` 会被
 *   `String.replace` 当成模式解释，而我们的替换体是 TS/JS 源码（含模板串），踩上就是静默改错。
 */
export const sub = (text, from, to) => {
  if (!from.includes("\n")) {
    if (!text.includes(from)) { return text; }
    /* `from` 单行、但 `to` 里**插入了新行**（"在某行后面加一行"这种变异）：
       同样要按目标文件的行尾拼，否则会往 CRLF 文件里塞 LF（文件变 MIXED，diff 整块变色）。
       ⚠️ 只有这种跨行 `to` 才走替换函数（避免 `$&`/`$1` 被当模式解释）；
       纯单行的 `to` 保持原来的 `replace(from, to)`，行为与旧脚本逐字一致。 */
    if (to.includes("\n")) {
      const body = to.split("\n").join(nlOf(text));
      return text.replace(from, () => body);
    }
    return text.replace(from, to);
  }
  const re = new RegExp(from.split("\n").map(escRe).join("\\r?\\n"));
  const body = to.split("\n").join(nlOf(text));
  return re.test(text) ? text.replace(re, () => body) : text;
};

/**
 * **多行**替换：行间用 `\r?\n` 连接（两侧行尾都认），替换体按该文件自己的行尾拼接。
 * ⇒ 对 LF / CRLF 都不敏感，且**不会**把 LF 塞进 CRLF 文件。
 *
 * 与 `sub` 的关系：`sub` 已经能自己识别多行，本函数保留给"用数组分行书写更清楚"的场合
 * （尤其是锚点行数多、或需要刻意强调它跨行时）。**两者都是行尾无关的。**
 */
export const subLines = (text, fromLines, toLines) => {
  const re = new RegExp(fromLines.map(escRe).join("\\r?\\n"));
  const body = toLines.join(nlOf(text));
  return re.test(text) ? text.replace(re, () => body) : text;
};

/** 把整段文本换到**相反**的行尾（用于自检："换个行尾还命中吗？"） */
export const withOtherEol = (text) =>
  text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text.replace(/\n/g, "\r\n");

/**
 * **行为级**行尾自检：逐条变异在"原行尾"和"相反行尾"下各跑一遍，报告两类问题。
 *
 * 为什么不做静态分析（扫源码找裸 `\n`）：锚点可能是正则、模板串、拼接出来的，
 * 静态判据会漏也会误报（实测第一版审计脚本因字符串里的括号不配对而误报 7 处）。
 * **直接跑一遍 mutate() 看命不命中**才是真判据 —— 它问的就是"换个行尾还认不认这个锚点"。
 *
 * 两类问题：
 *  ① `eol-sensitive`  —— 一条行尾下命中、另一条下**未命中**。这类变异在文件行尾翻转后会
 *     **静默失效**：脚本不报"未命中"以外的错，守卫"仍绿"看着像"改了但守住了"，实际一个字没改。
 *  ② `eol-pollute`    —— 命中，但替换结果把行尾**弄混**了（往 CRLF 文件里塞 LF）。
 *     危害不是漏测，而是把源文件改成 MIXED，`git diff` 整块变色、后续锚点更难命中。
 *
 * @param mutations 变异数组（每项需有 `name` / `file` / `mutate`）
 * @param root      仓库根（用于解析 `file` 相对路径）
 * @param readUtf8  读文件函数（默认 fs 的，注入便于测试）
 * @returns 问题列表（空数组 = 通过）
 */
export function eolProblems(mutations, root, readUtf8 = (p) => readFileSync(p, "utf8")) {
  const problems = [];
  for (const m of mutations) {
    const path = `${root}/${m.file}`;
    let orig;
    try {
      orig = readUtf8(path);
    } catch (e) {
      /* ⚠️ 这里**不许** `continue` 静默跳过。第一版写的就是 `catch { continue; }` +
         一个取错的默认读函数（`globalThis.readFileSync` 在 ESM 里是 undefined）——
         结果**每一条变异都被静默跳过**，自检恒返回空数组、"全部通过"。
         自检机制自己变成假绿，比没有自检更危险：它会让人以为这道门已经守住了。 */
      problems.push({ kind: "read-failed", name: m.name, detail: `${m.file} 读不到：${e?.message ?? e}` });
      continue;
    }
    const origIsCrlf = orig.includes("\r\n");
    const alt = withOtherEol(orig);

    const hitOrig = m.mutate(orig) !== orig;
    const hitAlt = m.mutate(alt) !== alt;

    if (hitOrig !== hitAlt) {
      problems.push({
        kind: "eol-sensitive",
        name: m.name,
        detail: `原行尾(${origIsCrlf ? "CRLF" : "LF"}) 命中=${hitOrig}，另一行尾 命中=${hitAlt}`,
      });
      continue;
    }
    if (!hitOrig) {
      continue; // 两边都没命中 → 是"锚点失效"，由主流程按"未命中"报错，这里不抢
    }
    // 命中：检查有没有把行尾弄混
    const out = m.mutate(orig);
    const polluted = origIsCrlf ? /[^\r]\n/.test(out) : out.includes("\r\n");
    if (polluted) {
      problems.push({
        kind: "eol-pollute",
        name: m.name,
        detail: `替换结果把行尾弄混了（原文件 ${origIsCrlf ? "CRLF" : "LF"}）`,
      });
    }
  }
  return problems;
}

/**
 * 自检机制的**反空转**探针：喂两条**已知**该被检出的合成变异，要求全被检出。
 *
 * 为什么必须有这一步：`eolProblems` 第一版因为默认读函数取错（`globalThis.readFileSync`
 * 在 ESM 里是 undefined）+ `catch { continue; }`，**对任何输入都返回空数组** ——
 * 一切看起来都"通过"。一个恒真的自检等于没有自检，而且更坏：它会让人以为这道门守住了。
 * 每次跑脚本时先跑本探针，等于给"检测能力"本身做一次体检。
 *
 * @returns 空数组 = 探针正常工作；否则返回问题描述
 */
export function selfTestEolDetector(root, readUtf8 = (p) => readFileSync(p, "utf8")) {
  const bad = [];
  // A. 行尾敏感：只在 CRLF 下命中
  const a = eolProblems([{
    name: "__selftest_eol_sensitive__",
    file: "gui/src/main/updater.ts",
    mutate: (t) => t.includes("autoUpdater.autoDownload = false;\r\n")
      ? t.replace("autoUpdater.autoDownload = false;\r\n", "") : t,
  }], root, readUtf8);
  if (a.length === 0) { bad.push("喂了『只在 CRLF 下命中』的锚点，却没有被检出 → 行尾敏感判据失效"); }
  // B. 行尾污染：往 CRLF 文件里插 LF
  const b = eolProblems([{
    name: "__selftest_eol_pollute__",
    file: "gui/src/main/updater.ts",
    mutate: (t) => t.replace("let currentStatus", "// x\nlet currentStatus"),
  }], root, readUtf8);
  if (b.length === 0) { bad.push("喂了『把 LF 插进 CRLF 文件』的锚点，却没有被检出 → 污染判据失效"); }
  // C. 读不到文件必须报错（而不是静默跳过）
  const c = eolProblems([{
    name: "__selftest_read_failed__",
    file: "gui/src/this-file-does-not-exist.ts",
    mutate: (t) => `${t} `,
  }], root, readUtf8);
  if (c.length === 0) { bad.push("喂了不存在的文件，却没有被检出 → 读失败被静默吞掉（这正是第一版的 bug）"); }
  // D. 干净的等价重写：不该误报
  const d = eolProblems([{
    name: "__selftest_clean__",
    file: "gui/src/main/updater.ts",
    mutate: (t) => t.replace("autoUpdater.autoDownload = false;", "autoUpdater.autoDownload = false;"),
  }], root, readUtf8);
  if (d.length !== 0) { bad.push("对『没有实际改动』的变异误报了"); }
  return bad;
}

/** 把 eolProblems 的结果打印成人类可读的报错；有问题时返回 true（调用方据此 exit 1） */
export function reportEolProblems(problems, tag) {
  if (problems.length === 0) { return false; }
  console.error(`\n[${tag}] 行尾自检未通过：${problems.length} 条`);
  for (const p of problems) {
    console.error(`  - ${p.kind}｜${p.name}\n      ${p.detail}`);
  }
  console.error(
    "  ⇒ 多行锚点一律改用 `subLines(text, [...], [...])`（本模块导出），" +
    "不要写裸 `\"...\\n...\"`（见 skill《mutation-harness》§5.1）。",
  );
  return true;
}
