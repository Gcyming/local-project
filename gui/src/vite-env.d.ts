/**
 * gui/src/vite-env.d.ts — Vite 特有导入形态的类型声明。
 *
 * `?raw` 是 Vite 内置能力（把文件读成字符串），但 TS 不认识这个后缀 ⇒ 需要这里声明，
 * 否则 `tsc --noEmit` 报「找不到模块」。目前唯一的用法是
 * `gui/src/main/docRenderPage.ts` 内联渲染库（pptx-preview / docx-preview / xlsx / jszip）。
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
