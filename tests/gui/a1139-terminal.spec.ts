/**
 * tests/gui/a1139-terminal.spec.ts — 「内置终端适配主机本地终端组件」的守卫（A-1139）。
 *
 * ## 这一轮要解决的是什么
 * 用户实测（2026-10-01）：「内置终端体验很差……**我本地部分代码都无法适配**，你给我全面优化
 * 一下，**适配现在终端的所有样式**，可以在使用时**自适应直接接入主机本地终端的各个组件**」
 * —— 对标 VS Code 的终端下拉。
 *
 * 三个根因，各自都要有守卫：
 *  ① **永远是 cmd**：旧实现是主进程 `exec(cmd)`（平台默认 shell）⇒ 现在按探测到的 profile 起进程。
 *  ② **中文乱码**：`exec` 把输出按 UTF-8 解，而中文 Windows 控制台是 CP936(GBK)。
 *  ③ **转义垃圾**：`\x1b[32m` / `\x1b[K` 被原样打印 ⇒ 现在按 `parseAnsi` 渲染、剥掉光标控制。
 *
 * ## ⚠️ 判据为什么必须锚"行为/形状"而不是"有这个文件"
 *   · `shellInvocation`：cmd 的 `/d /s /c`、VS 的 `call ... &&`、WSL 的 `--cd` —— 少一个参数
 *     就"跑得起来但语义不对"（例如没 `call` 时用户命令根本不执行，**不报错**）。
 *   · `resolveCd`：它错了的后果是**命令跑在用户没预期的目录里**，比"cd 不生效"更糟 ⇒
 *     所以这里既测"该算对的算对"，也测**"算不出来时必须返回 null"**（反例是判据的一半）。
 *   · `decodeBytes`：直接用**真实 GBK 字节**（`中国` = D6 D0 B9 FA）钉住，
 *     而不是拿一个字符串再编回去（那样会跟着实现一起漂）。
 *   · 接线：源码判据（同 A-1125 / A-1138 的做法）—— 主进程少一行 tsc / 单测 / 构建**全绿**。
 */

import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  shellInvocation,
  pickDefaultProfile,
  orderProfiles,
  resolveProfile,
  resolveCd,
  isAbsoluteTarget,
  joinTarget,
  normalizeTarget,
  PROFILE_KIND_ORDER,
  type TermProfile,
} from "../../core-ts/src/terminal/profiles.js";
import { parseAnsi, stripAnsi, hasAnsi, color256, ANSI_16 } from "../../core-ts/src/terminal/ansi.js";
import {
  decodeBytes,
  decodeHtmlBytes,
  normalizeCharset,
  charsetFromHtml,
  supportsEncoding,
  DEFAULT_FALLBACKS,
} from "../../core-ts/src/text/encoding.js";
import {
  whichInPath,
  decodeWslListOutput,
  parseWslList,
} from "../../gui/src/main/termProfiles.js";
import { IPC_CHANNELS } from "../../gui/src/shared/ipc.js";

const P = (over: Partial<TermProfile> & Pick<TermProfile, "kind" | "file">): TermProfile => ({
  id: over.id ?? over.kind,
  label: over.label ?? over.kind,
  ...over,
});

/* ══════════════ ① 怎么调一个 shell（纯判据，逐 kind 钉死）══════════════ */

describe("A-1139 ① shellInvocation", () => {
  it("cmd：`/d`（跳过 AutoRun）+ `/s`（引号语义）+ `/c`（执行完退出）", () => {
    expect(shellInvocation(P({ kind: "cmd", file: "cmd.exe" }), "dir")).toEqual({
      file: "cmd.exe", args: ["/d", "/s", "/c", "dir"],
    });
  });

  it("**vsdevcmd 必须 `call`**（直接跑 .bat 会终止整个 cmd ⇒ 用户的命令根本不执行，且不报错）", () => {
    const inv = shellInvocation(
      P({ kind: "vsdevcmd", file: "cmd.exe", setup: "C:\\VS\\VsDevCmd.bat" }),
      "cl",
    );
    expect(inv.args[3]).toBe('call "C:\\VS\\VsDevCmd.bat" >nul && cl');
    /* 判据就在 `call` 这个词上 —— 单独钉一次，避免正则写宽了把 `&& cl` 也放过。 */
    expect(inv.args[3]!.startsWith("call ")).toBe(true);
  });

  it("powershell / pwsh：`-NoLogo -NoProfile -NonInteractive -Command`（profile 会污染输出；交互提示会挂到超时）", () => {
    for (const kind of ["powershell", "pwsh"] as const) {
      expect(shellInvocation(P({ kind, file: "x.exe" }), "Get-Date").args)
        .toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-Date"]);
    }
  });

  it("vspwsh：先 dot-source 开发环境脚本并把输出吞掉（`| Out-Null`），再跑用户命令", () => {
    const inv = shellInvocation(P({ kind: "vspwsh", file: "pwsh.exe", setup: "C:\\VS\\Launch.ps1" }), "cl");
    expect(inv.args[4]).toBe('& "C:\\VS\\Launch.ps1" -Arch amd64 -HostArch amd64 | Out-Null; cl');
  });

  it("bash 用 `-lc`（登录 profile 才会把 /usr/bin 加进 PATH）", () => {
    expect(shellInvocation(P({ kind: "bash", file: "/bin/bash" }), "ls").args).toEqual(["-lc", "ls"]);
    expect(shellInvocation(P({ kind: "sh", file: "/bin/sh" }), "ls").args).toEqual(["-c", "ls"]);
  });

  it("wsl：`-d <发行版>` + **`--cd` 进 argv** + `-- bash -lc`（发行版路径宿主拼不出来）", () => {
    const inv = shellInvocation(P({ kind: "wsl", file: "wsl.exe", distro: "Ubuntu" }), "ls", "/home/me/p");
    expect(inv).toEqual({ file: "wsl.exe", args: ["-d", "Ubuntu", "--cd", "/home/me/p", "--", "bash", "-lc", "ls"] });
  });

  it("**只有 WSL 把 cwd 进 argv**：其余 kind 一律靠 spawn 的 cwd（注入 `cd` 会改用户命令文本）", () => {
    const cwd = "C:\\proj";
    for (const kind of ["cmd", "powershell", "pwsh", "bash", "sh", "vsdevcmd", "vspwsh"] as const) {
      const inv = shellInvocation(P({ kind, file: "x", setup: "s" }), "echo hi", cwd);
      expect(inv.args.join(" "), `${kind} 把 cwd 注进了命令`).not.toContain(cwd);
    }
    expect(shellInvocation(P({ kind: "wsl", file: "wsl.exe" }), "echo hi", cwd).args).toContain(cwd);
  });
});

/* ══════════════ ② 选哪个 shell ══════════════ */

describe("A-1139 ② 默认 profile / 排序 / id 失配", () => {
  const mk = (...kinds: TermProfile["kind"][]): TermProfile[] => kinds.map((k) => P({ kind: k, file: k }));

  it("Windows 优先 pwsh > powershell > cmd（装了 7 说明用户想要 7）", () => {
    expect(pickDefaultProfile(mk("cmd", "powershell", "pwsh"))?.kind).toBe("pwsh");
    expect(pickDefaultProfile(mk("cmd", "powershell"))?.kind).toBe("powershell");
    expect(pickDefaultProfile(mk("cmd"))?.kind).toBe("cmd");
  });

  it("**一个都没探测到 ⇒ null**（调用方必须给出可见说明，不许静默给个空列表）", () => {
    expect(pickDefaultProfile([])).toBeNull();
  });

  it("下拉顺序 = PROFILE_KIND_ORDER，且**同类相对顺序不变**（多个 WSL 发行版不能被打乱）", () => {
    const list = mk("bash", "wsl", "cmd", "pwsh");
    expect(orderProfiles(list).map((p) => p.kind)).toEqual(["pwsh", "cmd", "wsl", "bash"]);
    const ws = [
      P({ kind: "wsl", file: "wsl", id: "wsl:Ubuntu", distro: "Ubuntu" }),
      P({ kind: "wsl", file: "wsl", id: "wsl:Debian", distro: "Debian" }),
      P({ kind: "cmd", file: "cmd" }),
    ];
    expect(orderProfiles(ws).filter((p) => p.kind === "wsl").map((p) => p.distro)).toEqual(["Ubuntu", "Debian"]);
    expect(PROFILE_KIND_ORDER[0]).toBe("pwsh");
  });

  it("id 失配 ⇒ **退到默认而不是报错**（换了机器 / 卸了 PowerShell 7 后终端不能打不开）", () => {
    const list = mk("cmd", "pwsh");
    expect(resolveProfile(list, "wsl:Ubuntu")?.kind).toBe("pwsh");
    expect(resolveProfile(list, "")?.kind).toBe("pwsh");
    expect(resolveProfile(list, undefined)?.kind).toBe("pwsh");
    expect(resolveProfile(list, "cmd")?.kind).toBe("cmd");
    expect(resolveProfile([], "cmd")).toBeNull();
  });
});

/* ══════════════ ③ cwd 延续（`cd xxx` 之后的下一条命令）══════════════ */

describe("A-1139 ③ resolveCd", () => {
  const W = "C:\\proj\\app";
  const cd = (cmd: string, cwd = W, kind: TermProfile["kind"] = "cmd", home?: string): string | null =>
    resolveCd(cmd, cwd, kind, home)?.next ?? null;

  it("相对路径按当前 cwd 解析并归一（`.` / `..` / 重复分隔符）", () => {
    expect(cd("cd src")).toBe("C:\\proj\\app\\src");
    /* `C:\proj\app` 往上两级是**盘的根**（app → proj → C:\），不是 `C:\proj`。 */
    expect(cd("cd ..\\..\\other")).toBe("C:\\other");
    expect(cd("cd ..\\other")).toBe("C:\\proj\\other");
    expect(cd("cd .\\a\\..\\b")).toBe("C:\\proj\\app\\b");
    expect(cd("cd src\\")).toBe("C:\\proj\\app\\src");
  });

  it("绝对路径直接用（cmd 的 `/d` 只对 cmd 家族剥掉 —— bash 里 `cd /d` 是去 /d 目录）", () => {
    expect(cd("cd /d D:\\work")).toBe("D:\\work");
    expect(cd("cd D:\\work")).toBe("D:\\work");
    expect(resolveCd("cd /d", "/home/me", "bash")?.next).toBe("/d");
    /* ⚠️ **带参数**的形态才是判别器：`cd /d`（无参）里 `/d` 后面没有空白 ⇒ 剥与不剥
       结果都是 `/d`（假绿）。`cd /d sub` 才把「cmd 家族才剥 `/d`」这条规则分开。 */
    expect(resolveCd("cd /d sub", "/home/me", "bash")?.next).toBe("/d sub");
    expect(cd("cd /d sub")).toBe("C:\\proj\\app\\sub");
    expect(cd("/d sub")).toBeNull();
  });

  it("引号剥掉（`cd \"Program Files\"`）", () => {
    expect(cd('cd "C:\\Program Files"')).toBe("C:\\Program Files");
  });

  it("PowerShell 的 `Set-Location` / `sl` 同样识别（bash 里的 `sl` **不**算 —— 那是另一个程序）", () => {
    expect(cd("Set-Location src", W, "pwsh")).toBe("C:\\proj\\app\\src");
    expect(cd("sl ..", W, "powershell")).toBe("C:\\proj");
    expect(cd("sl ..", W, "bash")).toBeNull();
  });

  it("`~` 展开到 home（拿不到 home ⇒ 不展开，返回 null）", () => {
    expect(resolveCd("cd ~", "/home/me", "bash", "/home/me")?.next).toBe("/home/me");
    expect(resolveCd("cd ~/p", "/home/me", "bash", "/home/me")?.next).toBe("/home/me/p");
    expect(resolveCd("cd ~/p", "/home/me", "bash")).toBeNull();
  });

  it("裸 `cd`：bash/PowerShell 回 HOME；**cmd 只打印当前目录 ⇒ 不变**", () => {
    expect(resolveCd("cd", "C:\\p", "cmd")).toBeNull();
    /* ⚠️ 断言**必须带上 home**：不传它时 cmd 分支"回 HOME"会因为 home 是 undefined 而恰好
       也返回 null ⇒ 与"cmd 只打印"不可区分（假绿）。带上 home 才把两条路分开。 */
    expect(resolveCd("cd", "C:\\p", "cmd", "C:\\Users\\me")).toBeNull();
    expect(resolveCd("cd", "C:\\p", "vsdevcmd", "C:\\Users\\me")).toBeNull();
    expect(resolveCd("cd", "C:\\p", "pwsh", "C:\\Users\\me")?.next).toBe("C:\\Users\\me");
    expect(resolveCd("cd", "/home/me", "bash", "/home/me")?.next).toBe("/home/me");
  });

  /* ⚠️ **反例是判据的一半**：算不出来时必须返回 null（保持原 cwd），
     因为"算错"的后果是命令静默跑在用户没预期的目录里 —— 比"cd 不生效"糟得多。 */
  it("**组合命令一律不猜**（`&` / `&&` / `|` / `;` / 重定向 / 反引号 / 换行）", () => {
    for (const c of ["cd a && dir", "cd a & dir", "cd a | more", "cd a; ls", "cd a > x", "cd `pwd`", "cd a\nls"]) {
      expect(cd(c), `${c} 被当成了纯 cd`).toBeNull();
    }
  });

  it("**变量 / 通配 / 开关一律不猜**（真值只有 shell 自己知道）", () => {
    for (const c of ["cd %USERPROFILE%", "cd $HOME", "cd !TEMP!", "cd C:\\a*", "cd -Path foo", "cd -"]) {
      expect(cd(c), `${c} 被当成了可解析的 cd`).toBeNull();
    }
  });

  it("不是 cd 的命令 / 没有 cwd ⇒ null（不是回归：旧行为就是 cwd 不变）", () => {
    expect(cd("dir")).toBeNull();
    expect(cd("cd")).toBeNull();
    expect(cd("cdx src")).toBeNull();
    expect(resolveCd("cd src", undefined, "cmd")).toBeNull();
    expect(resolveCd("cd src", "", "cmd")).toBeNull();
    expect(resolveCd("   ", W, "cmd")).toBeNull();
  });

  it("`..` 越过根时**停在根**（与真实 shell 一致）", () => {
    expect(normalizeTarget("/a/../../b")).toBe("/b");
    expect(normalizeTarget("C:\\a\\..\\..\\b")).toBe("C:\\b");
  });

  it("路径 helper：分隔符跟**目标路径**走，不跟运行平台走（WSL 的 Linux 路径也算得对）", () => {
    expect(isAbsoluteTarget("C:\\x")).toBe(true);
    expect(isAbsoluteTarget("/home/x")).toBe(true);
    expect(isAbsoluteTarget("src")).toBe(false);
    expect(joinTarget("/home/me", "p/q")).toBe("/home/me/p/q");
    expect(joinTarget("C:\\me", "p\\q")).toBe("C:\\me\\p\\q");
  });
});

/* ══════════════ ④ ANSI 渲染 ══════════════ */

describe("A-1139 ④ ansi", () => {
  it("SGR 解析成样式 + 纯文本（`\\x1b[32mok\\x1b[0m` ⇒ 绿色 ok）", () => {
    const spans = parseAnsi("\u001b[32mok\u001b[0m");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("ok");
    expect(spans[0]!.fg).toBe(ANSI_16[2]);
  });

  it("**`0` 会重置**（不重置的话后面的普通文本会继承上一个颜色）", () => {
    const spans = parseAnsi("\u001b[31mred\u001b[0mplain");
    expect(spans).toHaveLength(2);
    expect(spans[1]!.text).toBe("plain");
    expect(spans[1]!.fg).toBeUndefined();
  });

  it("加粗/暗淡/下划线/斜体 + 亮色（90-97）", () => {
    const s = parseAnsi("\u001b[1;45;91mhi").at(0)!;
    expect(s).toMatchObject({ text: "hi", bold: true, bg: ANSI_16[5], fg: ANSI_16[9] });
    expect(parseAnsi("\u001b[2mx").at(0)!.dim).toBe(true);
    expect(parseAnsi("\u001b[4mx").at(0)!.underline).toBe(true);
    expect(parseAnsi("\u001b[3mx").at(0)!.italic).toBe(true);
  });

  it("**`38;5;n` 与 `38;2;r;g;b` 要把后续参数吃掉**（否则 `5` 被当成「闪烁」，颜色整个丢）", () => {
    const a = parseAnsi("\u001b[38;5;196mX").at(0)!;
    expect(a.fg).toBe(color256(196));
    expect(a.text).toBe("X");
    const b = parseAnsi("\u001b[38;2;10;20;30mX").at(0)!;
    expect(b.fg).toBe("rgb(10,20,30)");
  });

  it("**非 SGR 的控制序列一律剥掉**（我们不是终端模拟器，留着只会显示成垃圾字符）", () => {
    expect(stripAnsi("a\u001b[Kb")).toBe("ab");
    expect(stripAnsi("a\u001b[1Ab")).toBe("ab");
    expect(stripAnsi("a\u001b]0;title\u0007b")).toBe("ab");
    /* 纯控制行（进度条的擦除帧）⇒ 空数组 ⇒ 调用方跳过，而不是把转义原样显示出来。 */
    expect(parseAnsi("\u001b[K")).toEqual([]);
    expect(parseAnsi("")).toEqual([]);
  });

  it("**每段的文字不能变空**（`{ text: plain, ...style }` 那种展开顺序会让空串盖掉文字）", () => {
    const spans = parseAnsi("hello \u001b[31mworld\u001b[0m !");
    expect(spans.map((s) => s.text).join("")).toBe("hello world !");
    expect(spans.map((s) => s.text)).not.toContain("");
  });

  it("`color256` 与 xterm 标准算法一致（16 是立方起点、232 起是灰阶）", () => {
    expect(color256(15)).toBe(ANSI_16[15]);
    expect(color256(16)).toBe("rgb(0,0,0)");
    expect(color256(21)).toBe("rgb(0,0,255)");
    expect(color256(232)).toBe("rgb(8,8,8)");
    expect(color256(255)).toBe("rgb(238,238,238)");
  });

  it("`hasAnsi` 只对真含转义的行返回 true（渲染层的纯文本快路径判据）", () => {
    expect(hasAnsi("\u001b[32mx")).toBe(true);
    expect(hasAnsi("plain")).toBe(false);
    expect(hasAnsi("")).toBe(false);
  });
});

/* ══════════════ ⑤ 编码（中文乱码的根治）══════════════ */

describe("A-1139 ⑤ encoding", () => {
  /* 真实 GBK 字节：`中国` = D6 D0 B9 FA。**不拿字符串编回去**（那样会跟实现一起漂）。 */
  const GBK_ZHONGGUO = Uint8Array.from([0xd6, 0xd0, 0xb9, 0xfa]);

  it("合法 UTF-8 ⇒ 判为 utf-8 且 `loose === false`（严格解码从不误判）", () => {
    const r = decodeBytes(new TextEncoder().encode("中文 ok"));
    expect(r).toEqual({ text: "中文 ok", encoding: "utf-8", loose: false });
  });

  it("**GBK 字节严格 UTF-8 一定抛 ⇒ 退 GB18030**，解出的是正确汉字且 `loose === true`", () => {
    const r = decodeBytes(GBK_ZHONGGUO);
    expect(r.text).toBe("中国");
    expect(r.encoding).toBe("gb18030");
    /* ⚠️ `loose` 是"我们没能确认编码"的信号 —— 界面必须显示它（铁律 31）。 */
    expect(r.loose).toBe(true);
  });

  it("ASCII 永远判 utf-8（不误判成 GBK）", () => {
    expect(decodeBytes(Buffer.from("plain ascii")).encoding).toBe("utf-8");
  });

  it("BOM 是**权威**判据（有就照它解，不看别的）", () => {
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("ab", "utf16le")]);
    const r = decodeBytes(u16);
    expect(r.text).toBe("ab");
    expect(r.encoding).toBe("utf-16le");
    expect(r.loose).toBe(false);
    const u8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中", "utf8")]);
    expect(decodeBytes(u8)).toEqual({ text: "中", encoding: "utf-8", loose: false });
  });

  it("空字节 ⇒ 空串、不 loose（这不是「解码失败」）", () => {
    expect(decodeBytes(new Uint8Array(0))).toEqual({ text: "", encoding: "utf-8", loose: false });
  });

  it("兜底候选可以换（爬虫会把页面声明的 charset 排在前面）", () => {
    const big5 = Uint8Array.from([0xa4, 0xa4]); // `中` in Big5
    expect(decodeBytes(big5, ["big5"]).text).toBe("中");
    expect(decodeBytes(big5, ["big5"]).encoding).toBe("big5");
    /* 默认兜底是 GB18030，且**只**有它一个（GB18030 几乎不抛错 ⇒ 只能当兜底不能当判别器）。 */
    expect(DEFAULT_FALLBACKS).toEqual(["gb18030"]);
  });

  it("charset 归一：gb2312/gbk/x-gbk 一律 gb18030（后者是前两者的超集，解同一段字节结果一致）", () => {
    for (const c of ["GB2312", "gbk", "GB18030", "x-gbk"]) { expect(normalizeCharset(c)).toBe("gb18030"); }
    expect(normalizeCharset("UTF8")).toBe("utf-8");
    expect(normalizeCharset("Big5")).toBe("big5");
    expect(normalizeCharset("iso-8859-1")).toBe("windows-1252");
  });

  it("`<meta charset>` 优先于 `http-equiv`；取不到 ⇒ null", () => {
    expect(charsetFromHtml('<html><head><meta charset="gbk"></head>')).toBe("gb18030");
    expect(charsetFromHtml('<meta http-equiv="Content-Type" content="text/html; charset=gb2312">')).toBe("gb18030");
    expect(charsetFromHtml('<meta charset="utf-8">')).toBe("utf-8");
    expect(charsetFromHtml("<html><body>no meta")).toBeNull();
  });

  it("**`http-equiv` 分支必须活着**（它不只是「同一正则的第二产地」—— 有一个输入只有它认得出）", () => {
    /* ⚠️ 实测（7 个常见 http-equiv 形态）：常规输入的 `charset=` 会被上面那条**直接正则**
       先抓到、同值 ⇒ 删掉 http-equiv 分支在常规输入上**不可观测**（等价变异体）。
       唯一让两条路分开的是**直接正则的 `[^>]+` 跨不过**、而 http-equiv 正则的
       `[^"']*` 允许的那个 `>`（属性值里含 `>`）。它证明这条分支不是死代码 ⇒
       删掉它 = 破坏了「老页面（大量用 http-equiv）也能判出编码」的一部分可见性。 */
    expect(charsetFromHtml('<meta http-equiv="Content-Type" content="a>b; charset=gbk">')).toBe("gb18030");
    /* 没有 http-equiv 的裸 `charset=` 仍然走直接正则（上面那条，不受这里影响）。 */
    expect(charsetFromHtml('<meta name="x" content="charset=gbk">')).toBe("gb18030");
  });

  it("网页字节：页面自己说了 gbk 就照它解（比我们的启发式权威）", () => {
    const head = Buffer.from('<html><head><meta charset="gbk"></head><body>');
    const body = GBK_ZHONGGUO;
    const r = decodeHtmlBytes(Buffer.concat([head, Buffer.from(body)]));
    expect(r.text).toContain("中国");
    expect(r.encoding).toBe("gb18030");
    expect(r.loose).toBe(false);
  });

  it("`supportsEncoding` 认得的和不认得的分得开（精简运行时缺编码名时构造函数会抛）", () => {
    expect(supportsEncoding("utf-8")).toBe(true);
    expect(supportsEncoding("gb18030")).toBe(true);
    expect(supportsEncoding("no-such-encoding")).toBe(false);
  });
});

/* ══════════════ ⑥ 探测（PATH / `wsl -l -q` 的 UTF-16 坑）══════════════ */

describe("A-1139 ⑥ termProfiles 探测", () => {
  it("`whichInPath` 按 PATH + PATHEXT 找可执行文件（找不到 ⇒ null，不抛）", () => {
    const dir = mkdtempSync(join(tmpdir(), "slime-term-"));
    try {
      mkdirSync(join(dir, "bin"), { recursive: true });
      const exe = join(dir, "bin", "mytool.exe");
      writeFileSync(exe, "");
      const env = { PATH: join(dir, "bin"), PATHEXT: ".EXE;.CMD" } as NodeJS.ProcessEnv;
      /* ⚠️ 比**大小写不敏感**：探到的路径是用 `PATHEXT` 里那一段（`.EXE`）拼出来的，
           而磁盘上的文件名是 `.exe` —— NTFS 不区分大小写，两者指同一个文件。 */
      expect((whichInPath("mytool", env) ?? "").toLowerCase()).toBe(exe.toLowerCase());
      expect(whichInPath("nope", env)).toBeNull();
      /* ⚠️ 空 PATH 不能抛（探测失败的常态，不是异常）。 */
      expect(whichInPath("mytool", { PATH: "" } as NodeJS.ProcessEnv)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("**`wsl -l -q` 的输出是 UTF-16LE**：按 utf8 解会得到夹空字节的「假发行版名」（不报错、永远连不上）", () => {
    const typo = Buffer.from("Ubuntu\n", "utf8");
    expect(decodeWslListOutput(typo)).toBe("Ubuntu\n");
    const real = Buffer.from("Ubuntu\nDebian\n", "utf16le");
    /* 按 utf8 解这条字节会得到夹 \0 的串 —— 这正是"看起来像合法名字"的那个 bug。 */
    expect(Buffer.from(real).toString("utf8")).toContain("\u0000");
    expect(decodeWslListOutput(real)).toBe("Ubuntu\nDebian\n");
    /* BOM 形式也认。 */
    const bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Ubuntu\n", "utf16le")]);
    expect(decodeWslListOutput(bom)).toBe("Ubuntu\n");
  });

  it("`parseWslList` 去空行、去 `*` 前缀（默认发行版标记）、去残留空字节", () => {
    expect(parseWslList("* Ubuntu\n\n  Debian  \r\n")).toEqual(["Ubuntu", "Debian"]);
    expect(parseWslList("U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000\n")).toEqual(["Ubuntu"]);
    expect(parseWslList("")).toEqual([]);
  });
});

/* ══════════════ ⑦ 接线（源码判据 —— 少一行则门禁全绿而功能全没）══════════════ */

describe("A-1139 ⑦ 接线", () => {
  const SRC = (rel: string): string => readFileSync(resolve(__dirname, "../../", rel), "utf8");
  /** 形状断言必须**先剥注释**（铁律 10）——否则"注释里提到过 `exec(cmd)`"会被读成"又用回去了"。 */
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const MAIN = SRC("gui/src/main/index.ts");
  const MAIN_CODE = stripComments(MAIN);
  const PRELOAD = SRC("gui/src/preload/index.ts");
  const SIDEBAR = SRC("gui/src/renderer/pages/RightSidebar.tsx");

  it("IPC 通道两边同名（`term_profiles`）—— 名字漂了就是「探测永远不返回」", () => {
    expect(IPC_CHANNELS.term_profiles).toBe("slime:term:profiles");
    expect(IPC_CHANNELS.term_exec).toBe("slime:term:exec");
  });

  it("主进程**注册了 shell 探测**且回带默认 id（没有它 ⇒ 下拉永远是空的）", () => {
    expect(MAIN_CODE).toContain('handleTrusted<undefined>("slime:term:profiles"');
    /* ⚠️ 必须锚住「`def` 从哪来」而不是只看回带那一行 —— `const def = null;` 会让
       `defaultId: def ? def.id : null` 这一行文本**照样存在**（文本判据的假绿陷阱）。 */
    expect(MAIN_CODE).toContain("const def = pickDefaultProfile(profiles);");
    expect(MAIN_CODE).toContain("defaultId: def ? def.id : null");
  });

  it("主进程执行命令时**走探测到的 profile**（判据 `resolveProfile` + `shellInvocation`）", () => {
    expect(MAIN).toMatch(/resolveProfile\(profiles, p\.profileId\)/);
    expect(MAIN).toContain("runShellCommand(shellInvocation(prof, cmd, cw.dir), prof, cw.dir)");
  });

  it("**不再用 `exec(cmd)`**（它是平台默认 shell，且按 UTF-8 解输出 ⇒ 中文乱码的两个根因）", () => {
    /* ⚠️ 判据看**调用**而不是词面：`exec(` 会误伤 `REGEX.exec(`。
       这里允许 `execFile(`（不经过 shell，安全）但不允许裸 `exec(`。
       ⚠️ 必须剥注释后再判 —— 文件里就有一句注释写着「为什么不再用 `exec(cmd)`」。 */
    expect(MAIN_CODE, "又回到 exec(cmd) 了").not.toMatch(/[^a-zA-Z.]exec\(/);
    /* 旧导入是 `{ spawn, exec, execFile, ... }` —— `exec,` 这一项必须已经消失。 */
    expect(MAIN_CODE, "`exec` 还在 child_process 的导入里").not.toMatch(/import \{[^}]*\bexec\b[^}]*\} from "node:child_process"/);
  });

  it("输出走 `decodeBytes` 并按编码**回带 loose 标记**（降级要看得见）", () => {
    expect(MAIN).toContain("decodeBytes(Buffer.concat(outChunks))");
    expect(MAIN).toContain("decodeBytes(Buffer.concat(errChunks))");
    expect(MAIN).toContain("looseEncoding = so.loose || se.loose");
  });

  it("**超时必须可见 + 杀进程树**（旧实现超时返回 ok:true + 部分输出 ⇒ 用户以为命令跑完了）", () => {
    expect(MAIN).toContain("killProcessTree(child.pid");
    expect(MAIN).toContain("命令超过 ${TERM_TIMEOUT_MS / 1000} 秒未结束，已终止进程树");
  });

  it("cwd 由**主进程定事实**并回带（渲染层不做推导 —— 算错会让命令静默跑错目录）", () => {
    expect(MAIN).toMatch(/res\.cwd = nextTermCwd\(cmd, cw\.dir, prof\.kind\)/);
    expect(MAIN).toContain("statSync(r.next).isDirectory() ? r.next : cwd");
    /* ⚠️ WSL 的路径在发行版内部，宿主 `statSync` 必然失败 ⇒ 必须放行。 */
    expect(MAIN).toContain('if (kind === "wsl") { return r.next; }');
  });

  it("**WSL 那条命令的 `spawn` 不能带宿主 cwd**（发行版路径在宿主上不存在 ⇒ spawn 直接 ENOENT，终端整个用不了）", () => {
    /* 判据 = 「传给 spawn 的 cwd 对 wsl 是 undefined」。写成一行文本断言是有意的：
       这是**装配层**的例外（同 A-1125 / A-1138 的做法），纯函数那边（`shellInvocation`）
       已经把 `--cd` 拼进 argv 了，单测覆盖不到的是"宿主 cwd 又被 spawn 用了"这一半。 */
    expect(MAIN_CODE).toContain('cwd: prof.kind === "wsl" ? undefined : spawnCwd,');
  });

  it("preload：`exec` 带上 profileId，并暴露 `profiles()`", () => {
    expect(PRELOAD).toContain('ipcRenderer.invoke("slime:term:exec", { cmd, cwd, profileId })');
    expect(PRELOAD).toContain('ipcRenderer.invoke("slime:term:profiles")');
  });

  it("渲染层：下拉选择 shell + 用 `parseAnsi` 渲染 + 显示 notice（三条都要在，少一条就退回旧体验）", () => {
    expect(SIDEBAR).toContain("api?.term?.profiles?.()");
    expect(SIDEBAR).toContain("onChange={(e) => setProfileId(e.target.value)}");
    expect(SIDEBAR).toContain("parseAnsi(line)");
    expect(SIDEBAR).toMatch(/if \(res\.notice\) \{ extra\.push\(\{ kind: "notice"/);
    /* cwd 以主进程回带值为准。 */
    expect(SIDEBAR).toContain("setCwd(res.cwd ?? (props.workspace ?? \"\"))");
  });

  it("渲染层**没有**自己写一份 ANSI 解析（第二产地 ⇒ 必然与 `ansi.ts` 漂）", () => {
    expect(SIDEBAR).toContain('from "../../../../core-ts/src/terminal/ansi.js"');
    /* 转义序列的正则只该出现在 ansi.ts 里。 */
    expect(SIDEBAR, "渲染层自己写了一份转义序列匹配").not.toMatch(/u001b\[\d/);
  });
});
