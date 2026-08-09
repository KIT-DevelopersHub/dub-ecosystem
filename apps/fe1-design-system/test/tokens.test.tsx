import { describe, it, expect } from "vitest";
import { tokens, cssVariables, toCssVarName } from "@dub/tokens";

describe("@dub/tokens integration (FE1 consumes the frozen contract)", () => {
  it("light and dark expose the same CSS variable key set", () => {
    const light = Object.keys(cssVariables.light).sort();
    const dark = Object.keys(cssVariables.dark).sort();
    expect(dark).toEqual(light);
  });

  it("toCssVarName maps a dotted path to a var() reference", () => {
    expect(toCssVarName("color.brand.500")).toBe("var(--dub-color-brand-500)");
  });

  it("both themes define a brand-500 CSS variable", () => {
    expect(cssVariables.light["--dub-color-brand-500"]).toBeDefined();
    expect(cssVariables.dark["--dub-color-brand-500"]).toBeDefined();
  });

  it("TS token constants exist for both themes", () => {
    expect(tokens.light.color.brand[500]).toMatch(/^#/);
    expect(tokens.dark.color.brand[500]).toMatch(/^#/);
  });
});
