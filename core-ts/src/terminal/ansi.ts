/**
 * core-ts/src/terminal/ansi.ts — 终端输出的 **ANSI 转义序列解析**（纯函数，唯一产地）。
 *
 * ## 为什么需要它
 * 内置终端原先把输出**按纯文本一行行原样打印**。于是：
 *   · `git status` / `npm` / `pytest` 等工具输出的颜色码（`\x1b[32m`）会以 `←[32m`
 *     这种"乱码方块"的形式直接显示在界面上（用户看到的就是"终端很脏"）；
 *   · 更糟的是**光标控制序列**（`\x1b[K` 清行、`\x1b[1A` 上移一行）也被原样打印 ——
 *     而进度条（pip / curl / docker）正是靠它们原地刷新的，结果就是满屏重复的进度行。
 *
 * ## 判据：能渲染的渲染，不能渲染的**剥掉**
 * 我们不是终端模拟器（没有光标寻址、没有滚动区域），所以：
 *   · **SGR（`m` 结尾）** ⇒ 解析成颜色/字重，交给渲染层画（这是绝大多数工具的用法）；
 *   · **其它 CSI / OSC / 单字符转义** ⇒ 一律**剥离**。
 *     ⚠️ 剥离而不是保留是刻意的：留着这些字节只会显示成垃圾字符，而"看不见的光标指令"
 *     对用户来说比"少了一个颜色"无害得多。
 *
 * ⚠️ 本模块**不 import 任何东西**（纯字符串处理）⇒ 可被守卫逐条断言。
 */

/** 一段带样式的文本（渲染层按 `fg`/`bg`/字重画）。 */
export interface AnsiSpan {
  text: string;
  /** 前景色（CSS 颜色串；没指定 = 用默认前景）。 */
  fg?: string;
  /** 背景色。 */
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/**
 * 标准 16 色（暗色主题，与终端底色 `#0d1117` 配套）。
 * ⚠️ 索引即 SGR 码：0-7 = `30-37`，8-15 = `90-97`。
 */
export const ANSI_16: readonly string[] = [
  "#3b4048", // 0 black
  "#e5534b", // 1 red
  "#57ab5a", // 2 green
  "#c69026", // 3 yellow
  "#539bf5", // 4 blue
  "#b083f0", // 5 magenta
  "#39c5cf", // 6 cyan
  "#b3bac5", // 7 white
  "#545d68", // 8 bright black
  "#ff7b72", // 9 bright red
  "#7ee787", // 10 bright green
  "#e3b341", // 11 bright yellow
  "#79c0ff", // 12 bright blue
  "#d2a8ff", // 13 bright magenta
  "#56d4dd", // 14 bright cyan
  "#e6edf3", // 15 bright white
];

/** 256 色表的 16-231（6×6×6 立方）与 232-255（灰阶）。**与 xterm 的标准算法一致**。 */
export function color256(n: number): string {
  const i = Math.max(0, Math.min(255, Math.floor(n)));
  if (i < 16) { return ANSI_16[i]!; }
  if (i < 232) {
    const c = i - 16;
    const r = Math.floor(c / 36);
    const g = Math.floor((c % 36) / 6);
    const b = c % 6;
    const v = (x: number): number => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${v(r)},${v(g)},${v(b)})`;
  }
  const v = 8 + (i - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

/** 匹配所有转义序列：CSI（`ESC [ ... 参数 ... 终止符`）/ OSC（`ESC ] ... BEL|ST`）/ 单字符转义。 */
const ESC_RE = /\u001b\[([0-9;?]*)([ -/]*)([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** 剥掉全部转义序列（判"这行到底有没有可见文字"、以及纯文本回退时用）。 */
export function stripAnsi(s: string): string {
  return String(s ?? "").replace(ESC_RE, "");
}

/** 把 SGR 参数串应用到一个样式对象上（`0` 会重置）。 */
function applySgr(style: AnsiSpan, params: number[]): void {
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i]!;
    if (p === 0) {
      delete style.fg; delete style.bg;
      delete style.bold; delete style.dim; delete style.italic; delete style.underline;
    } else if (p === 1) { style.bold = true; delete style.dim; }
    else if (p === 2) { style.dim = true; delete style.bold; }
    else if (p === 3) { style.italic = true; }
    else if (p === 4) { style.underline = true; }
    else if (p === 22) { delete style.bold; delete style.dim; }
    else if (p === 23) { delete style.italic; }
    else if (p === 24) { delete style.underline; }
    else if (p >= 30 && p <= 37) { style.fg = ANSI_16[p - 30]; }
    else if (p === 39) { delete style.fg; }
    else if (p >= 40 && p <= 47) { style.bg = ANSI_16[p - 40]; }
    else if (p === 49) { delete style.bg; }
    else if (p >= 90 && p <= 97) { style.fg = ANSI_16[p - 90 + 8]; }
    else if (p >= 100 && p <= 107) { style.bg = ANSI_16[p - 100 + 8]; }
    else if (p === 38 || p === 48) {
      /* `38;5;n`（256 色）/ `38;2;r;g;b`（真彩）—— 两种都要把**后续参数吃掉**，
         否则 `5` 会被当成独立码（那是"闪烁"，很多终端也不实现，于是颜色整个丢）。 */
      const isFg = p === 38;
      const mode = params[i + 1];
      if (mode === 5) {
        const c = color256(params[i + 2] ?? 0);
        if (isFg) { style.fg = c; } else { style.bg = c; }
        i += 2;
      } else if (mode === 2) {
        const r = params[i + 2] ?? 0; const g = params[i + 3] ?? 0; const b = params[i + 4] ?? 0;
        const c = `rgb(${r},${g},${b})`;
        if (isFg) { style.fg = c; } else { style.bg = c; }
        i += 4;
      }
    }
  }
}

/**
 * 解析**一行**输出 → 若干带样式的片段。
 *
 * ⚠️ 只处理单行：调用方先按 `\n` 切分（与既有渲染方式一致）。跨行的 SGR 状态
 *   （上一行设了红色、下一行没重置）**不继承** —— 真实工具里这种写法极少，
 *   而为了它维护跨行状态会让"重画一行"变得很难正确。
 */
export function parseAnsi(line: string): AnsiSpan[] {
  const s = String(line ?? "");
  const out: AnsiSpan[] = [];
  const style: AnsiSpan = { text: "" };
  let plain = "";

  ESC_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  /* ⚠️ 不能写 `out.push({ text: plain, ...style })` —— `style.text` 是空串，
     展开顺序会让它**盖掉** `plain`，于是每一段都变空（一个不报错的静默清空）。 */
  const flush = (): void => {
    if (plain.length === 0) { return; }
    const span: AnsiSpan = { text: plain };
    if (style.fg !== undefined) { span.fg = style.fg; }
    if (style.bg !== undefined) { span.bg = style.bg; }
    if (style.bold) { span.bold = true; }
    if (style.dim) { span.dim = true; }
    if (style.italic) { span.italic = true; }
    if (style.underline) { span.underline = true; }
    out.push(span);
    plain = "";
  };
  while ((m = ESC_RE.exec(s)) !== null) {
    plain += s.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[3] === "m") {
      flush(); // 样式从这里开始生效 ⇒ 先把上一段落下去
      const params = (m[1] ?? "").split(";").map((x) => (x === "" ? 0 : Number(x)));
      applySgr(style, params.filter((n) => Number.isFinite(n)));
    }
    /* 非 SGR 的转义（光标/擦除/OSC）⇒ 只"吃掉"，不产出任何可见内容。 */
  }
  plain += s.slice(last);
  flush();
  /* 空数组 = "这一行没有任何可见内容"（纯控制序列，如进度条的擦除帧）⇒ 调用方应跳过它，
     而不是把那串转义原样显示出来（那正是用户看到的"脏"）。 */
  return out;
}

/** 这一行有没有 ANSI（渲染层可据此走"纯文本"快路径，省掉解析开销）。 */
export function hasAnsi(s: string): boolean {
  ESC_RE.lastIndex = 0;
  return ESC_RE.test(String(s ?? ""));
}
