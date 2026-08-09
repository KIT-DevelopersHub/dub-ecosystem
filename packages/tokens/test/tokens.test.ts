import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { tokens, cssVariables, toCssVarName } from "../src/index";
import { cssText } from "../src/css";
import { buildDtcgDocument } from "../src/dtcg";

const here = dirname(fileURLToPath(import.meta.url));

describe("@dub/tokens", () => {
  it("exposes both themes with identical structure", () => {
    expect(Object.keys(tokens).sort()).toEqual(["dark", "light"]);
    expect(tokens.light.color.brand[500]).toMatch(/^#/);
    expect(tokens.dark.color.text.primary).toMatch(/^#/);
  });

  it("light and dark CSS variable key sets match exactly (FE1 §7)", () => {
    const lightKeys = Object.keys(cssVariables.light).sort();
    const darkKeys = Object.keys(cssVariables.dark).sort();
    expect(darkKeys).toEqual(lightKeys);
    expect(lightKeys).toContain("--dub-color-brand-500");
    expect(lightKeys).toContain("--dub-space-4");
  });

  it("toCssVarName converts dotted paths to var() references", () => {
    expect(toCssVarName("color.brand.500")).toBe("var(--dub-color-brand-500)");
    expect(toCssVarName("space.4")).toBe("var(--dub-space-4)");
  });

  it("css distribution emits :root and dark override blocks", () => {
    expect(cssText).toContain(":root {");
    expect(cssText).toContain(':root[data-theme="dark"] {');
    expect(cssText).toContain("--dub-color-brand-500:");
  });

  it("committed tokens.json (DTCG) stays in sync with TS constants", () => {
    const onDisk = JSON.parse(readFileSync(join(here, "..", "tokens.json"), "utf8"));
    expect(onDisk).toEqual(buildDtcgDocument());
    expect(onDisk.light.color.brand["500"].$type).toBe("color");
  });
});
