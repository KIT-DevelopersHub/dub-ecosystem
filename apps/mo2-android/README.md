# @dub/mo2-android (MO2 — Android front)

`kind=mobile`. A **pure MO3 mobile-bff client** (theme14: MO1/MO2 know only MO3;
never call api-gateway or services directly). The production app is Kotlin +
Jetpack Compose; this package is the **portable client-core (TS 枠)** that the
Kotlin app mirrors 1:1, and the place where the client contract logic is unit-
tested in P0 (the JVM/Compose UI tests are a later wave — §7 test #2/#6).

## Why TypeScript here

The wire contract truth is `@dub/types` `mobile` namespace + referenced
namespaces (owner = MO3). Kotlin data classes are **generated from MO3's OpenAPI**
(`openapi-generator kotlin`; hand-writing forbidden — §5/§8 #3). Keeping the
client-core in the monorepo's TS toolchain lets us (a) consume the frozen
`@dub/types`/`@dub/errors` contracts directly, (b) pin the error-mapping,
optimistic-locking and auth-refresh semantics with fast vitest, and (c) hand the
Kotlin port a precise, tested behavioral spec. No backend, no Worker.

## Client-core modules (src/) -> Kotlin module mapping

| src file | responsibility | Kotlin module (§2-2) |
|---|---|---|
| `config.ts` | MO3 base URL, `/m/v1` prefix, App Link host, α defaults | `app` / `core:common` |
| `contract.ts` | consumed `@dub/types` re-exports + CONSUMED-SHAPE gaps | `core:model` (OpenAPI-gen) |
| `errors.ts` | `@dub/errors` envelope -> `AppError` (open-ended) | `core:network` ErrorMapper |
| `http.ts` | fetch transport, Bearer, JSON, failure normalization | `core:network` (Retrofit/OkHttp) |
| `auth-interceptor.ts` | single-token 401 -> refresh once -> retry/logout | `core:network` AuthInterceptor |
| `session-store.ts` | opaque token + refresh + server deviceId vault | `core:database` EncryptedDataStore |
| `bff-client.ts` | all `/m/v1/*` endpoint methods (S1–S9 + devices) | `core:network` |
| `task-repository.ts` | optimistic status change + 409 rollback/refetch | `feature:tasks` repo |
| `home-view-model.ts` | S2 MVI UiState machine (loading/content/error) | `feature:home` |
| `deep-link.ts` | App Links + `dub://` fallback -> Route | `app` NavHost |
| `push.ts` | FCM `MobilePushPayload` -> notification + tap route | `app` messaging |

## P0 scope (frozen contract only)

Implemented as tested logic: auth exchange/refresh (single opaque token, theme8),
home aggregate, events, my-tasks + single-PATCH optimistic locking (theme3 D4,
HTTP 409), inbox, preferences, device registration, deep-link + push routing,
`@dub/errors` -> `AppError` mapping (open-ended unknown codes -> Server).

Out of P0 (STUB / later wave, per §1 / §8): chat UI (S10, blocker C), gantt view
(S11), offline write queue (`/sync` `/mutations` are STUB), Compose UI /
screenshot / Maestro E2E tests.

## Contract gaps noted for MO3 (not re-implemented here)

The frozen `@dub/types` `mobile` namespace is intentionally lean vs. the P0a
design doc. These consumed shapes are declared app-locally in `contract.ts` as
`CONSUMED-SHAPE` and should land in the MO3-owned `mobile` namespace:

- **auth exchange/refresh response** (`{ token, refreshToken?, session }`) — no
  frozen type yet; theme8 single-opaque-token semantics.
- **`MobileHomeResponse.partialErrors` / `syncCursor`** — design §2-3/test #7
  reference them; the frozen type has only `upcomingEvents/myTasks/unreadCount`.
  Partial-success UI is deferred until MO3 adds the field (we consume frozen).
- **inbox/preferences/me endpoints** — consumed via `notification` namespace
  types (`ListInboxResponse`, `PreferenceEntry`); MO3 exposes them as `/m/v1`
  transparent-proxy routes.

## Commands

```
pnpm --filter @dub/mo2-android typecheck
pnpm --filter @dub/mo2-android test
```
