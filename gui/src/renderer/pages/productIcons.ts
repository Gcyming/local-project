/**
 * gui/src/renderer/pages/productIcons.ts — 产物卡的「扩展名 → 品牌图标」映射。
 *
 * **为什么独立成模块（A-990）**：这个映射（以及它引用的 15 个 svg）原先写在 `ChatPanel.tsx` 里。
 * 于是 `tests/core-ts/gui-products.spec.ts` 为了验证"pdf 映射到 pdf.svg"，
 * 只能 import 整个组件文件 —— 测试的模块图里因此包含一个 5000+ 行的 React 组件和它的全部资源。
 * 后果是根工程的类型检查被组件级资源导入拖红（本仓库真发生过 17 条 TS2307）。
 *
 * 为什么不干脆把映射改成"返回品牌 key、让组件查表"：那样测试就测不到"key 真的连到了存在的 svg"
 * —— 而这正是本用例的价值（防"图标已拷贝但 import 指向不存在文件"的幻觉）。
 * 所以把**资源依赖**隔离在这一个模块里：它只做映射、不含任何 React，
 * 组件与测试都从这里取图标，谁都不必碰对方。
 */

import wordIcon from "../assets/icons/word.svg";
import excelIcon from "../assets/icons/Excel.svg";
import pdfIcon from "../assets/icons/pdf.svg";
import pptIcon from "../assets/icons/ppt.svg";
import pythonIcon from "../assets/icons/python.svg";
import cssIcon from "../assets/icons/css.svg";
import tsIcon from "../assets/icons/ts.svg";
import gitIcon from "../assets/icons/git.svg";
import llamaIcon from "../assets/icons/llama.svg";
import fileTextIcon from "../assets/icons/file-text.svg";
import codeIcon from "../assets/icons/code.svg";
import fileZipIcon from "../assets/icons/file-zip.svg";
import imageIcon from "../assets/icons/image.svg";
import terminalIcon from "../assets/icons/terminal.svg";
import fileInfoIcon from "../assets/icons/file-info.svg";

/**
 * 通用文件图标（未收录扩展名的回退）。
 * 单独导出：组件里也有直接用它的地方（产物行的文件图标），
 * 让它走同一个 import，避免"同一个图标两条 import 路径"日后被某次清理拆散。
 */
export { fileInfoIcon };

/** 扩展名 → 产物卡图标 URL（按文件类型品牌色；未匹配回退通用 file-text） */
export function productIconUrl(ext: string | undefined): string {
  switch ((ext ?? "").toLowerCase()) {
    case "doc": case "docx":
      return wordIcon;
    case "xls": case "xlsx": case "csv":
      return excelIcon;
    case "pdf":
      return pdfIcon;
    case "ppt": case "pptx":
      return pptIcon;
    case "py": case "ipynb":
      return pythonIcon;
    case "css":
      return cssIcon;
    case "ts": case "tsx": case "mdx":
      return tsIcon;
    case "js": case "jsx": case "mjs": case "cjs":
      return codeIcon;
    case "gitignore":
      return gitIcon;
    case "gguf":
      return llamaIcon;
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "svg":
      return imageIcon;
    case "zip": case "tar": case "gz":
      return fileZipIcon;
    case "sh": case "bash":
      return terminalIcon;
    case "env": case "log": case "license":
      return fileTextIcon;
    case "html": case "htm": case "json": case "md": case "go": case "rs":
    case "toml": case "yml": case "yaml": case "xml": case "sql": case "txt":
    default:
      return fileInfoIcon;
  }
}
