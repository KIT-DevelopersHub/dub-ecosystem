// @dub/tokens/css — distribution form (b): CSS custom properties only, React-free.
// FE8 (Astro SSG) imports this and nothing else (FE1 §5). Default export is a CSS
// string exposing `:root` (light) and `[data-theme="dark"]` overrides.

import { cssVariables } from "./index";

function block(selector: string, vars: Record<string, string>): string {
  const lines = Object.entries(vars).map(([name, value]) => `  ${name}: ${value};`);
  return `${selector} {\n${lines.join("\n")}\n}`;
}

/** Full stylesheet string: light on `:root`, dark under `[data-theme="dark"]`. */
export const cssText: string = [
  block(":root", cssVariables.light),
  block(':root[data-theme="dark"]', cssVariables.dark),
].join("\n\n");

export default cssText;
