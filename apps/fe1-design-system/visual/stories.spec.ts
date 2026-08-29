// Visual regression over every @dub/ui Storybook story.
//
// Enumerates stories from the built catalog's `index.json`, then for each story
// loads the isolated `iframe.html` (no Storybook chrome) and pixel-compares a
// full-page screenshot in BOTH light and dark theme. The Playwright config runs
// this twice — once per viewport project (desktop 1280 / mobile 375) — so a
// single story yields desktop+mobile × light+dark baselines.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

type StoryEntry = { id: string; type: string; title: string; name: string };

function loadStories(): StoryEntry[] {
  const indexPath = join(__dirname, "..", "storybook-static", "index.json");
  let raw: string;
  try {
    raw = readFileSync(indexPath, "utf8");
  } catch {
    throw new Error(
      `Storybook build not found at ${indexPath}. Run \`pnpm --filter @dub/ui build-storybook\` first.`,
    );
  }
  const index = JSON.parse(raw) as { entries: Record<string, StoryEntry> };
  return Object.values(index.entries)
    .filter((e) => e.type === "story")
    .sort((a, b) => a.id.localeCompare(b.id));
}

const stories = loadStories();

// Themes map to the Storybook global set up in .storybook/preview.tsx (stamps
// data-theme + inlines @dub/tokens vars via ThemeProvider).
const THEMES = ["light", "dark"] as const;

test.describe("@dub/ui visual regression", () => {
  for (const story of stories) {
    for (const theme of THEMES) {
      test(`${story.id} [${theme}]`, async ({ page }) => {
        // Isolated story iframe — no sidebar/toolbar chrome, just the component.
        await page.goto(
          `/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story&globals=theme:${theme}`,
        );

        // Storybook signals a rendered story via #storybook-root; wait for it +
        // web fonts so text metrics are settled before the pixel compare.
        const root = page.locator("#storybook-root");
        await root.waitFor({ state: "attached" });
        await page.evaluate(() => document.fonts.ready);
        // Belt-and-braces: kill CSS transitions/animations for a still frame.
        await page.addStyleTag({
          content:
            "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}",
        });
        // Let a rAF settle after the style injection.
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => r(null))),
        );

        // Screenshot the story ROOT element (not fullPage): its box is the themed
        // surface decorator from .storybook/preview.tsx. Element-scoped capture is
        // deterministic — it avoids the viewport-scrollbar / fullPage-height jitter
        // that makes fullPage screenshots differ by a couple px run-to-run.
        await expect(root).toHaveScreenshot(`${story.id}-${theme}.png`);
      });
    }
  }
});
