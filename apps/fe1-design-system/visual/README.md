# @dub/ui Visual Regression

Pixel-diff visual regression for every `@dub/ui` component, built on Playwright's
built-in [`toHaveScreenshot()`](https://playwright.dev/docs/test-snapshots). It is
**completely free and self-hosted** — baselines are committed to this repo, diffs
surface as GitHub Actions artifacts. No SaaS (Chromatic / Percy), nothing paid.

## What it covers

- **Target:** the built static Storybook catalog (`storybook-static/`). Every story
  in `src/stories/**` is enumerated from `storybook-static/index.json` and captured
  in isolation via its `iframe.html` — so all `@dub/ui` components (Button … AppShell,
  Sidebar, Layout, DataTable, Modal, Timeline, MessageList, Tabs, Forms, States …).
- **Matrix:** each story × **2 viewports** (`desktop` 1280×800, `mobile` 375×812) ×
  **2 themes** (`light`, `dark`). Currently **57 stories → 228 snapshots**.
- The **375 px mobile viewport** is the guard against the responsive / overflow
  breakage (the Android-width class of bugs).

## Files

| File | Purpose |
| --- | --- |
| `playwright.config.ts` | Two viewport projects, snapshot path/tolerance, static web server. |
| `stories.spec.ts` | Enumerates stories from `index.json`, screenshots each `#storybook-root`. |
| `serve.mjs` | Zero-dependency static server for `storybook-static/` (no extra deps). |
| `__screenshots__/` | **Committed baselines.** `stories.spec.ts/<project>/<id>-<theme>-<platform>.png`. |

## Determinism — why baselines carry a platform suffix

`@dub/tokens` uses `system-ui` fonts, which rasterize differently per OS. Baselines
are therefore suffixed with `{platform}` (`-darwin.png` locally on macOS,
`-linux.png` in CI). The two sets **coexist** — they never clobber each other:

- **CI** runs inside the pinned Playwright Docker image
  (`mcr.microsoft.com/playwright:v1.62.1-jammy`, matching the installed
  `@playwright/test` version) → stable `*-linux.png`.
- **Local macOS** runs produce `*-darwin.png` for fast local iteration.

Tolerance is a small absolute `maxDiffPixels: 60` (not a percentage) — rendering is
deterministic within one OS, so this only absorbs the odd 1-px anti-alias flicker
while still catching a localized change (e.g. a border-radius / spacing shift on a
single component) that a ratio would dilute against the story's whitespace.

## Commands

Run from the repo root (all scoped to `@dub/ui`):

```bash
# One-time: install the Chromium binary locally (CI's Docker image already has it).
pnpm --filter @dub/ui visual:install

# Build the Storybook the tests screenshot (required before running / updating).
pnpm --filter @dub/ui build-storybook

# Compare against committed baselines (this is what CI runs).
pnpm --filter @dub/ui visual

# Open the HTML report (expected / actual / diff for each failure).
pnpm --filter @dub/ui visual:report
```

## Updating baselines (after an INTENTIONAL UI change)

A real UI change makes the affected stories red — that is the tool working. To accept
the new look, regenerate the baselines:

- **Linux baselines (what CI diffs against) — the source of truth.** Run the
  **`Visual Baselines (seed/update)`** workflow (Actions → run `workflow_dispatch`,
  input = your branch). It regenerates `*-linux.png` inside the CI Docker image and
  commits them back to the branch. Also how the baselines are **seeded the first time**.

  Locally with Docker installed you can do the same without CI:

  ```bash
  docker run --rm -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.62.1-jammy \
    bash -c "corepack enable && pnpm install --frozen-lockfile && \
             pnpm --filter @dub/ui build-storybook && pnpm --filter @dub/ui visual:update"
  ```

- **macOS baselines (local dev convenience):**

  ```bash
  pnpm --filter @dub/ui build-storybook
  pnpm --filter @dub/ui visual:update   # writes *-darwin.png
  ```

Review the changed PNGs in the diff/report before committing — that review is the
whole point of the gate.

## Adding a new snapshot

Nothing to wire up: add a `*.stories.tsx` under `src/stories/`. The spec discovers it
from `index.json` automatically. Rebuild Storybook and run `visual:update` (Linux via
the workflow above) to create its baselines, then commit them.

## CI

`.github/workflows/visual-regression.yml` runs on PRs/pushes that touch
`apps/fe1-design-system/**` or `packages/tokens/**`, inside the pinned Playwright
image. On failure it uploads `visual-diff-report` (the HTML report + actual/diff PNGs)
so the regression is reviewable directly from the PR's Actions run. It is an
**independent job** — the existing `ci.yml` (typecheck · test · build) is untouched.

## Extending to full app screens (next step)

This suite covers components. To also guard assembled **screens** (app-shell/launcher,
gantt, notifications, mail, chat, roster), add a second Playwright project whose
`webServer` boots the `fe2-app-shell` in backend-free demo mode (`VITE_DEMO=1`, which
already auto-logs-in and seeds data — see `apps/fe2-app-shell/playwright.config.ts`),
navigate to each screen via the app launcher, and `toHaveScreenshot()` at the same two
viewports. The Storybook `Layout/AppShell` + `Sidebar` stories already cover the shell
chrome in the meantime.
