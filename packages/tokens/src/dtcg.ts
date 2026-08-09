// @dub/tokens DTCG builder — distribution form (c): W3C Design Tokens (DTCG) tree.
// MO1/MO2 consume the emitted `tokens.json` via style-dictionary v4 (FE1 §5).
// `tokens.json` is generated from these functions (see scripts/gen-tokens-json.mjs)
// and a test asserts the committed file equals `buildDtcgDocument()` output, so the
// three distribution forms can never drift.

import { tokens, type DubTokens, type ThemeName } from "./index";

export interface DtcgToken {
  $value: string | number;
  $type: string;
}
export type DtcgGroup = { [key: string]: DtcgGroup | DtcgToken };

function dtcgType(path: string): string {
  if (path.startsWith("color.")) return "color";
  if (path.startsWith("space.") || path.startsWith("radius.")) return "dimension";
  if (path.startsWith("font.family.")) return "fontFamily";
  if (path.startsWith("font.size.")) return "dimension";
  if (path.startsWith("font.weight.")) return "fontWeight";
  if (path.startsWith("font.lineHeight.")) return "number";
  if (path.startsWith("shadow.")) return "shadow";
  if (path.startsWith("zIndex.")) return "number";
  if (path.startsWith("breakpoint.")) return "dimension";
  if (path.startsWith("motion.easing")) return "cubicBezier";
  if (path.startsWith("motion.")) return "duration";
  return "other";
}

function walk(obj: Record<string, unknown>, prefix: string): DtcgGroup {
  const group: DtcgGroup = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object") {
      group[key] = walk(value as Record<string, unknown>, path);
    } else {
      group[key] = { $value: value as string | number, $type: dtcgType(path) };
    }
  }
  return group;
}

export function buildDtcg(theme: DubTokens): DtcgGroup {
  return walk(theme as unknown as Record<string, unknown>, "");
}

export function buildDtcgDocument(): Record<ThemeName, DtcgGroup> {
  return {
    light: buildDtcg(tokens.light),
    dark: buildDtcg(tokens.dark),
  };
}
