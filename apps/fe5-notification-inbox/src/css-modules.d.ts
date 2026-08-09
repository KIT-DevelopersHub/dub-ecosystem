// Ambient module declarations for CSS Modules (@dub/tokens CSS variables are
// referenced inside these files). Class maps are typed as string records.
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
declare module "*.css";
