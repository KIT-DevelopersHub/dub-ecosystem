// Emit distribution form (b) as a real stylesheet: dist/tokens.css.
// The `./css` entry ships the CSS as a JS string (for FE8 SSG inlining); this
// companion emits an importable `.css` asset so SPA bundlers (FE2 Vite) can pull
// the global `:root` (light) + `[data-theme="dark"]` custom properties into the
// build output. Run automatically after `tsup` (see package.json build script).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cssText } from "../dist/css.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "dist", "tokens.css");
const banner = "/* @dub/tokens — generated global custom properties. Do not edit by hand. */\n";
writeFileSync(out, banner + cssText + "\n");
console.log("wrote", out);
