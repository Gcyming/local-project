













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






export { fileInfoIcon };


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
