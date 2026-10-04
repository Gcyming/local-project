import io
p = "core-ts/src/tools/builtin.ts"
b = open(p, "rb").read()
s = b.decode("utf-8")

# 1) 导入
old_imp = 'import { extractDocText, docKindFromExt, legacyBinaryName, extractOleText, oleKindFromExt } from "../doc_text.js";'
new_imp = old_imp + '\nimport { writeDocument, type DocFormat } from "../office/docWrite.js";'
assert old_imp in s, "imp"
s = s.replace(old_imp, new_imp, 1)

# 2) 执行体 + 格式表（插在 fileWrite 之后，紧邻它的下一个顶层函数之前）
anchor = "async function fileRead("
assert anchor in s, "exec anchor"
exec_code = '''/**
 * 扩展名 → 生成格式的**唯一产地**。
 * ⚠️ 判据只用**目标路径的扩展名**（不看内容）：调用方要生成什么，由文件名说清楚。
 */
const DOC_CREATE_FORMATS: Record<string, DocFormat> = {
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
  ".pdf": "pdf",
  ".csv": "csv",
  ".md": "md",
  ".txt": "txt",
};

/**
 * `docs_create` 的执行体：按扩展名生成**真正的** Office / 文档文件（不是只写文本）。
 *
 * ## 为什么需要这个工具（2026-09-30 用户原话：「office 办公文件，slime 能不能读取并修改，
 * 用户有需求时，能否自己按用户要求，从零生成、创建？」）
 * 审计发现：`core-ts/src/office/docWrite.ts::writeDocument()` 早就实现了 docx/xlsx/pptx/pdf 的
 * **真容器生成**（OOXML 部件齐全、有完整的 round-trip 测试），IPC `slime:docs:create` 也接好了 ——
 * 但**没有任何 Agent 工具包装它**（`docs_create` 通道只有声明、零消费者）。
 * ⇒ 结果是：**能读、能画，但 Agent 自己一个字都生成不了**，用户让它"做个 Excel"它只能拒绝或写 CSV。
 *   本工具把那条断链接上。
 *
 * ## ⚠️ 边界（与 `fileWrite` **同一套**，新工具绝不是绕过沙箱的口子）
 * 项目根 / 工作目录内 + 符号链接拒绝 + 敏感路径黑名单，全走同一条 `resolveInProject`。
 *
 * ## ⚠️ 只创建**新文件**，目标已存在就拒绝
 * `docWrite` 的产物是**二进制**，而"改动账本"（`recordFileChange`）记的是**字符串**旧内容 ⇒
 * 若允许覆盖，就会造出「能回滚、但回滚出来是个坏文件」的**假承诺** —— 比"不支持回滚"更坏。
 * 文本格式（.csv/.md/.txt）要覆盖请走 `file_write`，它本来就有账本与 diff。
 */
async function docsCreate(args: Record<string, unknown>): Promise<string> {
  const path = String(args.path ?? "").trim();
  if (!path) { return "[错误] 缺少 path 参数"; }
  if (!("body" in args)) { return "[错误] 缺少 body 参数"; }
  const body = String(args.body ?? "");
  const title = typeof args.title === "string" ? args.title : undefined;

  const ext = extname(path).toLowerCase();
  const format = DOC_CREATE_FORMATS[ext];
  if (!format) {
    return `[错误] 不支持的目标格式「${ext || "(无扩展名)"}」。可用：${Object.keys(DOC_CREATE_FORMATS).join(" / ")}`;
  }

  const ws = String(args._workspace ?? "");
  const sandboxAllowed = args._sandbox_allowed === true;
  try {
    const p = projectRootPath(path, ws);
    const abs = await resolveInProject(p, ws, sandboxAllowed);
    if (isBlockedWritePath(abs, ws)) {
      return `[错误] 敏感文件/目录禁止写入: ${path}`;
    }
    /* ⚠️ **不许覆盖已有文件**（理由见函数头）：给一条可操作的出路，而不是只说"不行"。 */
    try {
      await stat(abs);
      return `[错误] 目标已存在：${path}。本工具只**新建**文件（二进制文档不支持回滚，覆盖会造成`
        + `"能回滚但文件已坏"的假承诺）。请换一个路径，或先删掉它。`;
    } catch { /* 不存在 = 正是我们要的 */ }

    const r = await writeDocument({ path: abs, format, title, body });
    if (!r.ok) { return `[错误] 生成失败：${r.error}`; }
    return `已生成 ${r.path}（${format}，${r.bytes} 字节）。`;
  } catch (e) {
    return `[错误] ${e instanceof Error ? e.message : String(e)}`;
  }
}

'''
s = s.replace(anchor, exec_code + anchor, 1)

# 3) 注册（插在 file_read 之前，与其它文件类工具相邻）
reg_anchor = '''  registry.register(new Tool({
    name: "file_read",'''
assert reg_anchor in s, "reg anchor"
reg_code = '''  /* 2026-09-30：把「Agent 自己从零生成 Office 文档」这条**断链**接上 ——
     能力（`office/docWrite.ts`）与通道（`slime:docs:create`）本来都在，
     缺的只是**一个给 Agent 用的工具**（审计时 `docs_create` 只有声明、零消费者）。 */
  registry.register(new Tool({
    name: "docs_create",
    description:
      "按内容**从零生成一个真正的文档文件**并落盘（不是只写文本）：docx / xlsx / pptx / pdf / csv / md / txt。"
      + "目标格式由 `path` 的**扩展名**决定。\\n"
      + "`body` 用**纯文本**表达结构，按格式解析：\\n"
      + "  · **docx**：`# 一级标题` / `## 二级标题` / `- 列表项` / 空行分段；\\n"
      + "  · **xlsx**：制表符或逗号分列、换行分行（**第一行当表头**）；\\n"
      + "  · **pptx**：**每页之间用一行 `---` 分隔**，页内第一行是标题；\\n"
      + "  · **pdf**：正文原样排版，超一页自动分页；\\n"
      + "  · **csv / md / txt**：正文原样落盘。\\n"
      + "父目录会自动创建。用户说「做个 Excel / 写个 Word / 生成一份 PPT / 导出 PDF」时用它。\\n"
      + "⚠️ 只**新建**文件；目标已存在会被拒绝（换个路径，或文本格式改用 `file_write`）。\\n"
      + "⚠️ 要**改**已有文档：先 `file_read` 读出内容，改好后用本工具写到**新路径**（本工具不做就地编辑）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标路径，扩展名决定格式（如 报告.docx / 数据.xlsx / 演示.pptx / 说明.pdf）" },
        body: { type: "string", description: "正文（结构写法见工具描述）" },
        title: { type: "string", description: "文档标题（可选；用于文档属性/标题栏）" },
      },
      required: ["path", "body"],
    },
    executeFn: docsCreate,
    permissions: ["write"],
    riskKind: "write",
    // 生成新文件属普通写入（受保护目录 / 敏感文件 / 越权路径仍由分类器拦）
    autoApprovable: true,
  }));
'''
s = s.replace(reg_anchor, reg_code + reg_anchor, 1)

open(p, "wb").write(s.encode("utf-8"))
print("docs_create 工具已加")
