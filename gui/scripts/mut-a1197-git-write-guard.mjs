#!/usr/bin/env node
/**
 * gui/scripts/mut-a1197-git-write-guard.mjs — A-1197「Git 工具族写入绕过」的变异验证。
 *
 * ## 这一轮补的是哪个洞（P0，已核实的可达链）
 * tools/git.py 的 _write_patch_file 原先**只判「在项目根内」**：既不认受保护目录，
 * 也不认敏感文件名/后缀，更不认 A-1197 的豁免与归属判定。可达链（非理论）：
 *   git_checkpoint_save 的 fallback 把**未追踪文件全文**以 "FILE <相对路径>" 行写进
 *   .slime/checkpoints/<id>.patch（采集源无过滤）→ git_checkpoint_restore(mode=files)
 *   解析 FILE 行后把 rel **原样**交给 _write_patch_file → 落盘。
 * 而 .slime/ 既不在 PROTECTED_DIRS 又被 .gitignore 忽略 ⇒ 它自己是「未追踪文件」
 * ⇒ 能进**下一轮** checkpoint 的采集包 ⇒ **自举闭环**。
 * 同族次生缺口：git_restore 的 paths **零校验**（git restore -- slime.toml 可回滚受保护文件）。
 *
 * ## 判据是 pytest，**不是** vitest —— 本脚本因此不进 _run-mut-batch.sh
 * ⚠️ gui/scripts/_run-mut-batch.sh 的判据**硬编码 vitest**（node_modules/vitest/vitest.mjs，
 *   且靠 "Tests N failed" 汇总行判红）。本轮的守卫是 tests/test_git_write_guard.py（pytest），
 *   套上去会得到「变异体全存活」的**假结论**（pytest 输出里没有 vitest 那行汇总）。
 *   ⇒ 所以：--apply / --restore 照常提供（人可手工逐条跑），**全量模式只打印 pytest 跑批
 *   配方**并 exit 1；逐条验证记录见本轮汇报。
 *   判据文件：tests/test_git_write_guard.py（27 例，A/B/C 三段行为断言 + D 段采集端端到端）。
 *
 * ## 每条变异 / 它描述的缺陷 / 被哪条守卫抓住
 * | # | 变异点 | 缺陷（若回归） | 抓住它的守卫 |
 * |---|---|---|---|
 * | 1 | 还原链完全不判黑名单 | 本轮 P0 原样复发：config/agents.json / core/agent.py 可被覆写 | A2 / A3 / A4 / A6 |
 * | 2 | 黑名单判定挪到 mkdir 之后 | 受保护目录的**父目录被凭空造出**（写入仍拦，但副作用已发生） | A2（父目录不得凭空出现）|
 * | 3 | 判定换成「静默 return」不 log | 静默失效：还原不完整但调用方毫不知情（项目铁律） | A1 / A2 / A3 / A4 / A6 / C3 |
 * | 4 | 判定只认目录、丢掉文件名/后缀 | slime.toml（名字在黑名单里，但不在受保护目录下）可被覆写 | A3 / B2 |
 * | 5 | git_restore 不做前置过滤 | 次生缺口复发：git restore -- slime.toml 直接回滚 | B1 / B2 / B3 / B5 |
 * | 6 | git_restore 命中即静默过滤那条 | 静默失效：调用方以为全部回滚了，实际那条还停在被改动态 | B7（混合批次不许只回滚一半）|
 * | 7 | 越界分支不再计入 blocked | git_restore 丢掉项目范围检查（口径与 _write_patch_file 不一致） | B6 |
 * | 8 | 采集端不判受保护路径 | 收窄回退：config/agents.json / slime.toml / core/agent.py 全文又进 patch 包 | D1 / D6 |
 * | 9 | 采集端不排除 .slime 自身 | checkpoint 自我引用、逐轮膨胀 | D3 |
 * | 10 | 采集端体积上限失效 | 大二进制/构建产物被搬进 patch 包 | D2 |
 * | 11 | 采集端过滤改成静默 | 静默失效：调用方以为文件都在包里，还原时才发现少了一批 | D5 |
 * | 12 | 采集端绕过过滤器（接线被摘掉） | 过滤器写对了却没接进 patch：收窄形同虚设（**只测函数测不出来**）| D1 / D2 / D3 |
 *
 * ## 第 8~12 条（本轮新增）：采集端收窄的回归
 * 还原端（A/B/C 段）已经拒收受保护路径，但采集端原先**零过滤** ⇒
 * 受保护文件的**全文**以 `FILE <相对路径>` 写进 `.slime/checkpoints/<id>.patch`，
 * 而 `.slime/` 自己（被 .gitignore 忽略 ⇒ 属未追踪）又进下一轮采集包 ⇒ 逐轮膨胀。
 * 收窄是纯收益（还原端本来就拒收 ⇒ 功能零损失）。
 * ⚠️ **M12 是本组唯一只能靠端到端断言抓住的一条**：过滤器函数本身完好（M8~M11 全绿），
 *   坏的是「结果有没有真的接进 patch 文件」。只测 `_filter_checkpoint_untracked`
 *   的守卫对它完全无感 ⇒ D1/D2/D3 走完整 `git_checkpoint_save` 并读 patch 内容。
 * ⚠️ name 序号 == 数组位置（check-mut-anchors 逐条核对）；锚必须**唯一**（`anchor` 与
 *   `sub()` 首参是同一份字面量，逐条数命中数，非 1 直接拒绝开跑 —— `String.replace`
 *   只改第一处，命中 >1 会「改错对象还报成功」）。
 * ⚠️ **--restore 无条件可执行**（不跑任何门禁）：源码已漂移时门禁会挡在还原前面，
 *   造成「还原没执行、变异体留在源码里」（a1197-exec-layer 首轮实测事故）。
 *   铁律：任何 exit 1 都必须发生在「不改文件」或「已还原」之后。
 * ⚠️ **apply 先落盘 .orig 备份**再改文件；apply 报成功 ⇒ 备份一定在（否则 restore 必失败）。
 * ⚠️ 注释里**不放反引号**（STR 扫描器会被它截断，见 A-1188 教训）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { sub, subAll, eolProblems, reportEolProblems, selfTestEolDetector, escRe } from "./_mut-eol.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* ⚠️ 判据不是 vitest spec，而是 pytest 文件。保留 SPECS 形状是为了让
 *   _run-mut-batch.sh 那套「从脚本读判据清单」的机制不至于踩空，
 *   但**不要**把它当 vitest spec 传给跑批（见文件头 §判据是 pytest）。 */
const SPECS = [
  "tests/test_git_write_guard.py",
];

const F_GIT = "tools/git.py";
const TARGETS = [F_GIT];

const SAVE_DIR = join(ROOT, "gui", "scripts", "_tmp-mut-a1197-git-write");

/* ⚠️ 锚抽成**模块级字面量常量**：check-mut-anchors.mjs 静态只认 `from:` 与
 *   `sub(t, <字面量|常量>)` 两种形态，锚藏在闭包局部变量里会被判「未核验」，
 *   而未核验 = 没人核验 = 没有保护（该脚本文件头 §8.5）。
 *   `sub` 行尾无关（多行锚点的行间用 \r?\n 匹配），所以字面量里的 \n 是安全的。 */

/** M1：还原链彻底不判黑名单（本轮 P0 原样复发）。
 *  ⚠️ 替换体必须**保持语法合法**：把整块 if 连同 log.warning 一起换成
 *  `if False: pass` —— 只换 `if ...:` 那行会让 log.warning 与 return 变成孤儿语句
 *  ⇒ IndentationError ⇒ pytest 报的是 **collection error 而不是断言失败**，
 *  按 _run-mut-batch.sh 第 3 条判据（要有 Tests failed 汇总行）这**不算「被抓住」**。 */
const A1_BLOCK_ANCHOR =
  '    if _is_blocked_write_path(target):\n'
  + '        log.warning(\n'
  + '            "[tools/git] checkpoint 还原跳过受保护文件（写入黑名单）：%s"\n'
  + '            "（还原链不再是写入后门；口径与 file_write 一致）", rel,\n'
  + '        )\n'
  + '        return';

/** M3：拒绝分支里**只**删掉 log.warning（留静默 return）——「静默失效」那条。
 *  ⚠️ 锚只用 log.warning 那一段（不含 `return`），否则它与 M1 的锚重叠、
 *  两条变异会退化成同一个缺陷形态，白占一个编号。 */
const A_LOG_BLOCK =
  '        log.warning(\n'
  + '            "[tools/git] checkpoint 还原跳过受保护文件（写入黑名单）：%s"\n'
  + '            "（还原链不再是写入后门；口径与 file_write 一致）", rel,\n'
  + '        )\n';

/* ⚠️ M4 的锚与 M1 相同（同一块代码），但**变异体不同**，避免两处漂移：
 *   M1 = 整块不判；M4 = 仍判，但口径缩水（只认受保护目录）。
 *   两者描述的是不同的缺陷形态：M1 漏全部，M4 只漏敏感文件名/后缀（slime.toml 漏网）。 */

/* ── ② 判定挪到 mkdir 之后 ──────────────────────────────────────────
 * ⚠️ 这条变异揭示的**真实**缺陷（首跑时名字写错、实测才看清楚）：先 mkdir 会在
 *   受保护/豁免目录下**凭空造出目录**，而 builtin 的归属判据是「看磁盘上这个目录
 *   存不存在 + 有没有 agent 来源声明」—— 目录一旦被 mkdir 造出来，判据就变成
 *   「已存在且无声明」⇒ 合法的自建插件被**误判成别人建的**而拦掉。
 *   ⇒ 这正是「判定必须放在 mkdir 之前」的理由，且它是一条真实回归，不是形式主义。 */
const A2_REORDER_FROM =
  '    if _is_blocked_write_path(target):\n'
  + '        log.warning(\n'
  + '            "[tools/git] checkpoint 还原跳过受保护文件（写入黑名单）：%s"\n'
  + '            "（还原链不再是写入后门；口径与 file_write 一致）", rel,\n'
  + '        )\n'
  + '        return\n'
  + '    target.parent.mkdir(parents=True, exist_ok=True)';

const A2_REORDER_TO =
  '    target.parent.mkdir(parents=True, exist_ok=True)\n'
  + '    if _is_blocked_write_path(target):\n'
  + '        log.warning(\n'
  + '            "[tools/git] checkpoint 还原跳过受保护文件（写入黑名单）：%s"\n'
  + '            "（还原链不再是写入后门；口径与 file_write 一致）", rel,\n'
  + '        )\n'
  + '        return';

/** M5：git_restore 的前置过滤整块。 */
const B_GUARD_BLOCK =
  '    blocked: list[str] = []\n'
  + '    for p in paths:\n'
  + '        raw = Path(p)\n'
  + '        if not raw.is_absolute():\n'
  + '            raw = _PROJECT_ROOT / raw\n'
  + '        try:\n'
  + '            resolved = raw.resolve()\n'
  + '            resolved.relative_to(_PROJECT_ROOT.resolve())\n'
  + '        except ValueError:\n'
  + '            blocked.append(f"{p}（超出项目范围）")\n'
  + '            continue\n'
  + '        if _is_blocked_write_path(resolved):\n'
  + '            blocked.append(p)\n'
  + '    if blocked:';

/** M7：越界分支（不再计入 blocked ⇒ git_restore 丢掉项目范围检查）。 */
const B_OUTSIDE_BLOCK =
  '        except ValueError:\n'
  + '            blocked.append(f"{p}（超出项目范围）")\n'
  + '            continue';

/** M6：整单拒绝那一块（改成静默过滤）。
 *  ⚠️ 锚必须覆盖**整块**（含 return 表达式的所有续行）：首版只锚前两行，
 *  替换后 `+ "\n  - ".join(blocked)` 那几行变成孤儿语句 ⇒ IndentationError
 *  ⇒ pytest 报 collection error 而非断言失败 ⇒ 按判据这不算「被抓住」。 */
const B_DENY_BLOCK =
  '    if blocked:\n'
  + '        return ("[拒绝] git_restore 命中受保护路径，已整单拒绝（未回滚任何文件）：\\n  - "\n'
  + '                + "\\n  - ".join(blocked)\n'
  + '                + "\\n口径与 file_write 一致（敏感文件名/后缀、受保护源码目录均禁写）。"\n'
  + '                  "确需回滚请由用户手工执行 git restore。")';

/* ── 采集端（A-1197 续）专用锚点：M8 ~ M12 ────────────────────────────────
 * 五条全部作用在 git_checkpoint_save 的 fallback 采集链上。
 * ⚠️ 每条锚在 tools/git.py 里都**恰好命中 1 次**（已实测）——
 *   `if skipped:` 这类短行尤其危险：日后有人在别处也写一个同名分支，锚就会命中 >1
 *   ⇒ 核验器报「不唯一」并拒绝开跑。那是**期望行为**（宁可停下也不改错对象），
 *   遇到时该收窄锚点，而不是去调宽核验判据。 */

/** M8：采集端不判受保护路径（收窄回退 ⇒ 受保护文件全文又进 patch 包）。 */
const CP_PROTECTED_CHECK =
  '        if not reason and _is_blocked_write_path(abs_path):\n'
  + '            reason = SKIP_REASON_PROTECTED';

/** M9：采集端不排除 .slime 自身（checkpoint 自我引用、逐轮膨胀）。 */
const CP_SELF_REF_CHECK =
  '        try:\n'
  + '            abs_path.relative_to(slime_dir)\n'
  + '            reason = SKIP_REASON_SELF_REF\n'
  + '        except ValueError:\n'
  + '            pass';

/** M10：采集端体积上限失效（大二进制/构建产物被搬进 patch 包）。 */
const CP_SIZE_CHECK =
  '        if not reason and sz > CHECKPOINT_UNTRACKED_MAX_BYTES:';

/** M11：采集端过滤改成**静默**（跳过项不报告 ⇒ 调用方误以为文件都在包里）。
 *  ⚠️ 锚必须覆盖**整个 if 块**：只删 log.warning 会让 if 体变空。
 *  ⚠️⚠️ 替换体**必须是合法语句**，不能写 `if False:` —— 空的 if 体在这里紧跟
 *    `return keep, skipped`，而 return 是**函数级**缩进 ⇒ 空 if 体导致 IndentationError
 *    ⇒ pytest 报的是 **collection error 而不是断言失败** ⇒ 按判据这**不算「被抓住」**
 *    （实测踩到：M11 首版就是这么写的，输出是 `1 error during collection`）。
 *    改成 `if skipped: pass` —— 判定还在、块体合法、但**一个字都不说**。 */
const CP_LOUD_BLOCK =
  '    if skipped:\n'
  + '        detail = "、".join(\n'
  + '            f"{r} {sum(1 for _, x in skipped if x == r)} 条"\n'
  + '            for r in (SKIP_REASON_PROTECTED, SKIP_REASON_TOO_LARGE, SKIP_REASON_SELF_REF)\n'
  + '            if any(x == r for _, x in skipped)\n'
  + '        )\n'
  + '        log.warning(\n'
  + '            "[tools/git] checkpoint 采集过滤：跳过 %d 条未追踪文件（%s）；其中最大的一条 %s（%.1f MB）。"\n'
  + '            "这些路径还原端本就会拒收，采进包也只是白存。",\n'
  + '            len(skipped), detail, biggest[0], max(biggest[1], 0) / 1024 / 1024,\n'
  + '        )';

/** M12：采集端**绕过**过滤器（接线被摘掉）。
 *  ⚠️ 这条是本组里**唯一只能靠端到端断言抓住**的：过滤器函数本身完好无损
 *    （M8~M11 全绿），坏的是「结果有没有真的接进 patch 文件」。
 *    只测 `_filter_checkpoint_untracked` 的守卫对这条完全无感 ⇒ D1/D2/D3 必须走
 *    完整 git_checkpoint_save 并**读 patch 内容**。 */
const CP_WIRING_CALL =
  '            untracked_keep, untracked_skipped = _filter_checkpoint_untracked(untracked_lines)';

const MUTATIONS = [
  /* ── 1 还原链完全不判黑名单（本轮 P0 原样复发）────────────────────── */
  {
    name: "1 _write_patch_file 不再判写入黑名单（checkpoint 还原链=P0 写入绕过原样复发）",
    file: F_GIT,
    anchor: A1_BLOCK_ANCHOR,
    mutate: (t) => sub(
      t,
      A1_BLOCK_ANCHOR,
      "    if False:  # 变异体：黑名单判定被摘掉\n        pass",
    ),
  },
  /* ── 2 判定挪到 mkdir 之后 ⇒ 凭空造目录，归属判据被带偏 ──────────── */
  {
    name: "2 判定挪到 mkdir 之后（凭空造目录 ⇒ 合法自建插件被误判成别人的而拦掉）",
    file: F_GIT,
    anchor: A2_REORDER_FROM,
    mutate: (t) => sub(t, A2_REORDER_FROM, A2_REORDER_TO),
  },
  /* ── 3 静默失效：拦下了却一声不吭 ───────────────────────────────── */
  {
    name: "3 拒绝改成静默 return 不出声（还原不完整但调用方毫不知情）",
    file: F_GIT,
    anchor: A_LOG_BLOCK,
    mutate: (t) => sub(t, A_LOG_BLOCK, "        return  # 变异体：静默跳过"),
  },
  /* ── 4 判定口径缩水：退回「只看是否在项目根内」───────────────────── */
  {
    name: "4 判定退回只看是否在项目根内（敏感文件名/后缀整类漏网，含 slime.toml）",
    file: F_GIT,
    anchor: A1_BLOCK_ANCHOR,
    mutate: (t) => sub(
      t,
      A1_BLOCK_ANCHOR,
      "    if target.parent == _PROJECT_ROOT:  # 变异体：口径退回老逻辑\n        pass",
    ),
  },
  /* ── 5 git_restore 不做前置过滤（同族次生缺口复发）──────────────── */
  {
    name: "5 git_restore 不做受保护路径前置过滤（git restore -- slime.toml 可回滚）",
    file: F_GIT,
    anchor: B_GUARD_BLOCK,
    mutate: (t) => sub(
      t,
      B_GUARD_BLOCK,
      "    blocked: list[str] = []  # 变异体：前置过滤被摘掉\n    if False:",
    ),
  },
  /* ── 6 静默过滤那条（而非整单拒绝）─────────────────────────────── */
  {
    name: "6 git_restore 命中即静默过滤掉那条（调用方误以为全部已回滚）",
    file: F_GIT,
    anchor: B_DENY_BLOCK,
    mutate: (t) => sub(
      t,
      B_DENY_BLOCK,
      "    if blocked:  # 变异体：静默过滤掉被拒的那些，剩下的照常 restore\n"
      + "        paths = [p for p in paths if p not in blocked]\n",
    ),
  },
  /* ── 7 越界分支不再计入 blocked ────────────────────────────────── */
  {
    name: "7 越界路径不再计入 blocked（git_restore 丢掉项目范围检查）",
    file: F_GIT,
    anchor: B_OUTSIDE_BLOCK,
    mutate: (t) => sub(t, B_OUTSIDE_BLOCK, "        except ValueError:  # 变异体：越界不再计入\n            pass"),
  },
  /* ── 8 采集端不判受保护路径（收窄回退）────────────────────────────── */
  {
    name: "8 采集端不判受保护路径（config/agents.json / slime.toml / core/agent.py 全文又进 patch 包）",
    file: F_GIT,
    anchor: CP_PROTECTED_CHECK,
    mutate: (t) => sub(
      t,
      CP_PROTECTED_CHECK,
      "        if False:  # 变异体：采集端不再判受保护路径\n            pass",
    ),
  },
  /* ── 9 采集端不排除 .slime 自身 ──────────────────────────────────── */
  {
    name: "9 采集端不排除 .slime 自身（checkpoint 自我引用、逐轮膨胀）",
    file: F_GIT,
    anchor: CP_SELF_REF_CHECK,
    mutate: (t) => sub(
      t,
      CP_SELF_REF_CHECK,
      "        pass  # 变异体：不再排除 .slime 自身",
    ),
  },
  /* ── 10 采集端体积上限失效 ──────────────────────────────────────── */
  {
    name: "10 采集端体积上限失效（大二进制/构建产物被搬进 patch 包）",
    file: F_GIT,
    anchor: CP_SIZE_CHECK,
    mutate: (t) => sub(
      t,
      CP_SIZE_CHECK,
      "        if False:  # 变异体：体积上限失效",
    ),
  },
  /* ── 11 采集端过滤静默失效 ──────────────────────────────────────── */
  {
    name: "11 采集端过滤改成静默（跳过项不报告，调用方误以为文件都在包里）",
    file: F_GIT,
    anchor: CP_LOUD_BLOCK,
    mutate: (t) => sub(
      t,
      CP_LOUD_BLOCK,
      "    if skipped:  # 变异体：跳过项照常拦，但一个字都不说\n        pass",
    ),
  },
  /* ── 12 采集端绕过过滤器（接线被摘掉）─────────────────────────────── */
  {
    name: "12 采集端绕过过滤器（过滤器完好但结果没接进 patch，收窄形同虚设）",
    file: F_GIT,
    anchor: CP_WIRING_CALL,
    mutate: (t) => sub(
      t,
      CP_WIRING_CALL,
      "            untracked_keep, untracked_skipped = list(untracked_lines), []  # 变异体：绕过过滤",
    ),
  },
];

const abs = (rel) => join(ROOT, rel);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const argv = process.argv.slice(2);
const mode = argv.includes("--list") ? "list"
  : argv.includes("--restore") ? "restore"
    : argv.includes("--apply") ? "apply"
      : "full";

/* ⚠️⚠️ **门禁一律不许在 --restore 之前拦路**（a1197-exec-layer 首轮实测事故：
 *   把锚点计数闸门放在无条件位置 ⇒ --apply N 把源码改成变异态后，下一次 --restore
 *   被同一道闸门挡住（源码已漂移 ⇒ 命中 0 ⇒ exit 1）⇒ **还原逻辑根本没执行**，
 *   变异体留在源码里，M2~M7 全部报 --apply 失败，且源码从此停在变异态。
 *   ⇒ 还原路径必须无条件可执行；任何 exit 1 都必须发生在「不改文件」或「已还原」之后。 */
const gatesOk = () => {
  /* ── 行尾自检（检测器反空转 + 逐条锚点行尾无关性）── */
  const eolBad = selfTestEolDetector(ROOT);
  if (eolBad.length) {
    console.error("❌ 行尾检测器自检失败（检测能力本身可疑）：");
    for (const b of eolBad) { console.error(`  - ${b}`); }
    return false;
  }
  const eolFound = eolProblems(MUTATIONS, ROOT);
  if (reportEolProblems(eolFound, "mut-a1197-git-write")) { return false; }

  /* ⚠️ **自测计数不是 0**：本项目多次前科的根源都是「锚点写错/漂移 ⇒ 命中数 0 ⇒
   *   断言永远绿，跑批还报全部存活」，而真因是「一个字都没改」。
   *   所以开跑之前逐条数命中数：非 1 直接拒绝开跑。
   *   `anchor` 与 `mutate()` 里的第一个实参是同一份常量（显式抽出来只为能被这里数）。
   *
   * ⚠️⚠️ 计数必须**先归一化行尾**（tools/git.py 在 Windows 上是 CRLF，而锚字面量里
   *   写的是 \n）：直接 `src.split(anchor)` 在 CRLF 文件上恒为 0 ⇒ 门禁会误报「源码漂移」，
   *   而真因是**行尾不匹配**。这正是本项目「假红/假绿」家族里最隐蔽的一种 ——
   *   首次实跑本脚本时就被它顶住过一次（M1 报「锚点命中 0 次」而锚其实一字不差）。
   *   `sub()` 本身行尾无关，所以变异体照样落得了地；只有这里在骗人。 */
  const norm = (s) => s.replace(/\r\n/g, "\n");
  for (const [i, m] of MUTATIONS.entries()) {
    const src = readFileSync(abs(m.file), "utf8");
    const n = norm(src).split(norm(m.anchor)).length - 1;
    if (n !== 1) {
      console.error(`❌ M${i + 1} 锚点命中 ${n} 次（要求恰好 1）：${m.name}\n    ${m.anchor}\n`
        + "   ⇒ 命中 0 = 源码漂移（这条守卫已失去保护）；命中 >1 = 可能改错对象。");
      return false;
    }
    if (m.mutate(src) === src) {
      console.error(`❌ M${i + 1} 变异体没落地：${m.name}\n   ⇒ 守卫在这个脚本上是假绿，先修锚点。`);
      return false;
    }
  }
  return true;
};

/* --restore 无条件放行（见上方铁律）；--apply 只在自己要落地变异体时才需要门禁干净。 */
if (mode === "restore") { /* 故意不跑门禁 */ }
else if (!gatesOk()) { process.exit(1); }

if (mode === "list") {
  for (const [i, m] of MUTATIONS.entries()) { console.log(`  ${i + 1}. [${m.file}] ${m.name}`); }
  process.exit(0);
}

if (mode === "apply" || mode === "restore") {
  const manifestPath = join(SAVE_DIR, "manifest.json");
  if (mode === "apply") {
    const idx = Number(argv[argv.indexOf("--apply") + 1]);
    const m = MUTATIONS[idx - 1];
    if (!m) { console.error(`--apply 需要条目号（1..${MUTATIONS.length}）`); process.exit(1); }
    if (existsSync(manifestPath)) {
      console.error("上一轮的变异还没还原（manifest 还在）—— 先跑 --restore。");
      process.exit(1);
    }
    mkdirSync(SAVE_DIR, { recursive: true });
    const src = readFileSync(abs(m.file));
    /* ⚠️⚠️ **必须先把原文件落盘备份**，否则 --restore 读不到它（ENOENT 直接抛，
     *   还原逻辑死在第一行 ⇒ 变异体留在源码里）。
     *   实测踩到（a1197-exec-layer 首版）：apply 照样报「已变异」、
     *   manifest 也写出来了、唯独 .orig 不存在 —— 看起来完全成功，而 restore 必然失败。
     *   **apply 报成功 ⇒ 备份一定在**，这是唯一自洽的不变量。 */
    writeFileSync(join(SAVE_DIR, `${basename(m.file)}.orig`), src);
    const text = src.toString("utf8");
    let next;
    try { next = m.mutate(text); }
    catch (e) {
      console.error(`锚点未命中（变异体没落地）：${m.name}\n    ${e.message}`);
      rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1);
    }
    if (next === text) {
      console.error(`锚点未命中：${m.name}`);
      rmSync(SAVE_DIR, { recursive: true, force: true }); process.exit(1);
    }
    writeFileSync(abs(m.file), next);
    writeFileSync(manifestPath, JSON.stringify({
      index: idx, name: m.name, file: m.file,
      sha256: createHash("sha256").update(src).digest("hex"),
    }, null, 2));
    console.log(`已变异 M${idx}：${m.name}`);
    process.exit(0);
  }
  if (!existsSync(manifestPath)) { console.log("没有待还原的变异 —— 无需操作。"); process.exit(0); }
  const man = JSON.parse(readFileSync(manifestPath, "utf8"));
  const backup = join(SAVE_DIR, `${basename(man.file)}.orig`);
  /* ⚠️ 备份缺失时**必须先说清后果再退出**，不许让 readFileSync 抛栈
   *   （否则调用方只看到一串 fs 栈，完全不知道该手工还原哪个文件）。 */
  if (!existsSync(backup)) {
    console.error(`❌ 备份缺失：${backup}\n   ⇒ ${man.file} 可能仍停在变异态（第 ${man.index} 条：${man.name}）。\n`
      + `   请用 git 核对并手工还原：git diff -- ${man.file}`);
    process.exit(1);
  }
  writeFileSync(abs(man.file), readFileSync(backup));
  const now = hash(abs(man.file));
  rmSync(SAVE_DIR, { recursive: true, force: true });
  if (now !== man.sha256) {
    console.error(`❌ 还原校验失败：${man.file}\n   期望 ${man.sha256}\n   实际 ${now}`);
    process.exit(1);
  }
  console.log(`已逐字节还原 ${man.file}（sha256 一致）`);
  process.exit(0);
}

/* ── 全量模式：判据是 pytest，不是 vitest ⇒ 打印手工跑批配方后 exit 1 ── */
console.error("本轮判据是 **pytest**（tests/test_git_write_guard.py），不是 vitest。");
console.error("gui/scripts/_run-mut-batch.sh 的判据硬编码 vitest，套上来只会得到");
console.error("「变异体全存活」的假结论（pytest 输出里没有 vitest 那行 Tests 汇总）。");
console.error("本环境禁 node→node 孙进程（spawnSync 报 EBUSY），脚本自己跑不了 pytest。");
console.error("");
console.error("请在 shell 顶层逐条跑（判据 = pytest）：");
console.error("  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do");
console.error("    node gui/scripts/mut-a1197-git-write-guard.mjs --apply $i || continue");
console.error("    py -3 -m pytest tests/test_git_write_guard.py -q");
console.error("    node gui/scripts/mut-a1197-git-write-guard.mjs --restore");
console.error("  done");
console.error("");
console.error(`判据文件：${SPECS.join(" ")}`);
if (TARGETS.length !== 1) { process.exit(1); }
process.exit(1);