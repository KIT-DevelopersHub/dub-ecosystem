// @dub/app-ui components import CSS modules; this ambient declaration lets the TS
// program resolve `*.module.css` specifiers (they resolve to a class-name map).
declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}
