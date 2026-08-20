declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

// Side-effect stylesheet imports (e.g. @dub/ui/style.css).
declare module "*.css";
declare module "@dub/ui/style.css";
