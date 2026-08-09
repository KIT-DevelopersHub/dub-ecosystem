// Regenerate tokens.json from the built TS source of truth.
// Run: pnpm --filter @dub/tokens build && node scripts/gen-tokens-json.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDtcgDocument } from "../dist/dtcg.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "tokens.json");
writeFileSync(out, JSON.stringify(buildDtcgDocument(), null, 2) + "\n");
console.log("wrote", out);
