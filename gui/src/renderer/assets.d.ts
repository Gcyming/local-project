/** vite 静态资源导入类型（svg/png 等 URL 模块） */
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.png" {
  const src: string;
  export default src;
}