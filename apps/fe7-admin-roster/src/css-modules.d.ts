// FE7 consumes @dub/ui (apps/fe1-design-system) from source (no dist is built in
// the monorepo). Its components import CSS modules, so the TS program needs this
// ambient declaration to resolve `*.module.css` specifiers.
declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}
