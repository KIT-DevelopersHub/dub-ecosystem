# @dub/fe2-app-shell (FE2)

Admin SPA **shell & frontend cross-cutting foundation** — the `apps/admin-spa` base.
FE2 owns the frame and plumbing only; FE3–FE7 plug their screens in via the
`FeatureModule` contract. Design source of truth: `設計_P0a/frontend/FE2-app-shell.md`
+ `_P0b凍結サマリ_2026-08-09.md`.

## Stack

React 18 · Vite · TanStack Router · TanStack Query v5 · Zustand (UI state only) ·
CSS Modules (`@dub/tokens`). Types from `@dub/types`, error envelope from `@dub/errors`.

## What lives here

| Area | File | Notes |
|---|---|---|
| API client | `src/lib/api-client.tsx` | Single gateway surface. `credentials:"include"`, `x-dub-request-id`, 401→silent refresh(once)→retry, GET-only 5xx/network exponential retry, `ApiError`, `toDisplayableError` (ja copy) |
| Offline transport | `src/lib/mock-api-client.tsx` | `createMockFetch()` — MSW-style `fetch` serving the boot surface (`/me`, `/bff/home`, `/auth/*`) from seed data; only transport is swapped, the api-client logic runs unchanged. Enabled by `VITE_API_MOCK=true` (see below) |
| Home dashboard | `src/shell/screens/HomeScreen.tsx` + `HomeWidgetFrame.tsx` | FE2-owned cards (upcoming events, unread count) from `/bff/home` + feature-contributed `FeatureModule.homeWidget`s, each boxed in a per-widget error boundary |
| Feature deep-import boundary | `src/composition/featureEntries.tsx` | The single place reaching into FE4/FE6 `src/...` paths (they have no `exports` map yet). Swap for package roots here when fe4/fe6 ship export maps |
| Query conventions | `src/lib/queryKeys.tsx` | `me` / `bffHome` / `feature(id, …)` |
| Optimistic mutation | `src/lib/optimistic.tsx` | `createOptimisticMutation` — FE3–FE7 must route edits through it; destructive ops stay non-optimistic |
| Auth guards | `src/auth/AuthProvider.tsx` | `useAuth` / `useRequireAuth` / `usePermissions` / `RequireAuth` / `RequirePermission` — **fail-closed while `/me` loads** |
| UI store | `src/store/uiStore.tsx` | Theme (source of truth, `dub.ui.theme`) + sidebar |
| FeatureModule registry | `src/modules/*` | Route flatten (nested children), nav sort, module-perm merge, **duplicate segment ⇒ startup error** |
| BFF home | `src/bff/useBffHome.tsx` | Partial-failure `errorFor(source)` per widget frame |
| Shell | `src/shell/*` | `AppRoot` (providers + ErrorBoundary), `AppShellLayout` (FE1 composition), router, 4 screens |
| Public contract | `src/index.tsx` | The `@spa/shell` surface FE3–FE7 import |

## Scripts

`pnpm --filter ./apps/fe2-app-shell test` · `… typecheck` · `… build` · `… dev`

### Offline dev (no backend)

`VITE_API_MOCK=true pnpm --filter ./apps/fe2-app-shell dev` boots the assembled
shell against the built-in mock transport (`createMockFetch`): the shell
authenticates and the home dashboard renders from seed data with no gateway.
Unset (the default) keeps the prod wiring (`VITE_API_BASE_URL` → `api.developershub.jp`).
The mock covers the boot surface only; unknown feature routes resolve to a
`NOT_FOUND` envelope so feature screens show their own in-frame fallback.

## Deviations & stubs (deliberate; noted for the integration wave)

- **FE1 not built yet** → `src/stubs/dub-ui.tsx` + `src/stubs/icons.tsx` stand in for
  `@dub/ui` / `@dub/ui/icons` (AppShell/Sidebar/PageHeader/Button/ThemeProvider/Toast,
  `IconName`, `DisplayableError`, `testId`). Prop surfaces match the frozen FE1 contract,
  so swapping to the real package is an import change.
- **`MeResponse.permissions`** is used (the frozen `@dub/types` field). The P0a draft said
  `effectivePermissions`; the frozen contract wins.
- **Correlation field = `requestId`** (frozen wire in `@dub/errors`/`@dub/types`, E1
  resolution). The draft mentioned `correlationId`; `ApiError.correlationId` is kept as an
  alias getter for draft compatibility.
- **api-client lives in-app** (`src/lib/api-client.tsx`) rather than a separate
  `packages/api-client`, to keep this unit self-contained and avoid cross-unit file
  collisions. Move to a package during integration if desired; `src/index.tsx` re-exports it.
- **`@spa/shell` alias deferred** — FE3–FE7 import from `src/index.tsx` directly. Adding the
  alias requires a `paths` entry; done at integration time (app tsconfig re-declaring `paths`
  would shadow the inherited `@dub/*` map, so it was left out here).
- **RT / mail / chat / Queue** are not wired (9-B/C/E integration wave). The client exposes
  typed `chat`/`notifications` HTTP resources only; WebSocket connector is FE6-owned.
- **α defaults applied**: invite-based identity, `origin=github`, theme default `system`.

## Tests

69 unit/component tests (vitest + jsdom, co-located `*.test.tsx`). Real-browser E2E
(`POST /auth/test-login`) is deferred to the integration wave (#29) per design §7.
Tests are co-located under `src/` (not `test/`) so the root vitest glob
(`apps/*/test/**/*.test.ts`, node env) never picks up these jsdom tests.
