// Guards the CI check that keeps the staging debug menu out of production bundles.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain .mjs CLI script, no type declarations
import { findDebugMenuLeaks, DEBUG_MENU_MARKERS } from "../../scripts/assert-no-staging-debug.mjs";

function dist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fe2-dist-"));
  mkdirSync(join(dir, "assets"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe("assert-no-staging-debug", () => {
  it("passes a clean production bundle", () => {
    expect(findDebugMenuLeaks(dist({ "index.html": "<div id=root>", "assets/index.js": "console.log(1)" }))).toEqual([]);
  });

  it("flags every marker in JS chunks and sourcemaps", () => {
    const leaks = findDebugMenuLeaks(
      dist({ "assets/chunk.js": 'testId:"fe2-staging-debug-menu"', "assets/chunk.js.map": '"fe2-staging-debug-fab"' }),
    ) as { marker: string }[];
    expect(leaks.map((l) => l.marker).sort()).toEqual(["fe2-staging-debug-fab", "fe2-staging-debug-menu"]);
  });

  it("markers are the testIds the menu actually renders", async () => {
    const src = await import("./StagingDebugMenu.tsx?raw");
    for (const m of DEBUG_MENU_MARKERS as string[]) expect(src.default).toContain(m);
  });
});
