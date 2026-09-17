/**
 * react-dom/server 最小 ambient 声明（markdown spec 渲染测试用）。
 * @types/react-dom 19 未随包附 server 子模块声明（仅 client），
 * 全仓 tsconfig（含 tests）需要 renderToString 类型。仅声明本项目用到的成员。
 */
declare module "react-dom/server" {
  export function renderToString(element: unknown): string;
  export function renderToStaticMarkup(element: unknown): string;
}