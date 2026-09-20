/** vite 静态资源导入类型（svg/png/ico 等 URL 模块） */
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.png" {
  const src: string;
  export default src;
}
/** A-980-R17：app 图标 .ico（?url 显式资源导入） */
declare module "*.ico?url" {
  const src: string;
  export default src;
}