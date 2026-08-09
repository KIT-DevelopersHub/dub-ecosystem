# MO2 — native Android app (Kotlin + Jetpack Compose)

The production Android front for DevelopersHub (MO2). A **pure MO3 mobile-bff
client** (theme14: MO1/MO2 know only MO3). This is a **standalone Gradle build**
— it is intentionally *not* part of the pnpm/turbo monorepo graph (the monorepo
cannot build an Android app). Open this directory (`apps/mo2-android/android/`)
directly in Android Studio, or build with `./gradlew` from here.

The portable TS client-core one level up (`apps/mo2-android/src/`) is the tested
behavioral spec; every module below is a faithful Kotlin port of it. That TS and
the top-level `README.md` are owned elsewhere and are not touched by this app.

## Modules (§2-2)

| module | maps from (TS spec) | responsibility |
|---|---|---|
| `core:common` | `config.ts`, `session-store.ts` | MO3 base URL / `/m/v1` / App-Link host + α defaults; `SessionStore` contract + `InMemorySessionStore` |
| `core:model` | `contract.ts` + `@dub/types` | kotlinx.serialization wire data classes (OpenAPI-gen **target**, kept in lockstep with the frozen `@dub/types` namespaces — hand-writing divergent wire types is forbidden) |
| `core:network` | `errors.ts`, `http.ts`, `auth-interceptor.ts`, `bff-client.ts` | Retrofit/OkHttp transport, `@dub/errors` envelope → `AppError` mapper, single-token 401 `AuthInterceptor` (refresh once, coalesced), `MobileBffClient` |
| `core:database` | `session-store.ts` | `EncryptedDataStore` — Keystore-backed `EncryptedSharedPreferences` session vault |
| `feature:home` | `home-view-model.ts` | S2 home aggregate — MVI `HomeViewModel` (loading / content / error + stale-while-error) + `HomeScreen` |
| `feature:tasks` | `task-repository.ts` | S5/S6 — `TaskRepository` optimistic status change + HTTP 409 rollback/refetch (theme3 D4), `TasksViewModel`, `TaskDetailViewModel`, screens |
| `app` | `deep-link.ts`, `push.ts` | `MainActivity`, Compose `NavHost` (App Links + `dub://` fallback), FCM messaging service (stub), manual DI (`AppContainer`) |

## Architecture

- **MVI/UDF**: ViewModels expose an immutable `UiState` `StateFlow`; one-shot
  outcomes (409 conflict, failures) are `Channel`-backed effects. Compose screens
  are stateless and take the resolved state (preview/screenshot friendly).
- **Single network entry point**: everything goes through `MobileBffClient` →
  MO3 `/m/v1/*`. Auth-guarded calls run through `AuthInterceptor`; `auth/exchange`
  and `auth/refresh` do not (they mint/rotate the token).
- **Optimistic locking (theme3 D4)**: task status change applies optimistically,
  commits on 200, and on 409 rolls back then refetches server truth.
- **Secrets**: the session token / refresh token live only in `EncryptedDataStore`
  and are redacted from OkHttp logs. No `google-services.json` is committed.
- **Manual DI**: `AppContainer` (no Hilt/KSP) keeps wiring explicit and testable.

## Deep links (§2-4)

App Links `https://developershub.jp/{home|inbox|events/{id}|tasks/{id}}` are
canonical; `dub://…` is the fallback (`devhub://` retired). `parseDeepLink()` is
the single route table; the `NavHost` declares matching `navDeepLink` patterns and
push taps resolve through the same `Route`.

## FCM (stub)

`DubFirebaseMessagingService` parses incoming data messages via `parsePush()` into
the frozen `MobilePushPayload` and resolves the tap `Route`. Posting the system
notification and registering the token with MO3 (`registerDevice`) land in the
notification wave; the `google-services` plugin is **not** applied here (a real
Firebase project is a per-environment step).

## Build & test

Requires JDK 17+ and the Android SDK (compileSdk 36, minSdk 26). From this
directory:

```
./gradlew test              # JVM unit tests (repos, view-models, mappers, parsers)
./gradlew :app:assembleDebug
```

> This module is not wired into CI and is never deployed by this task — `done` =
> structurally complete + unit tests green under an Android toolchain.

### Unit test coverage (JVM, no device)

- `core:network` — `ErrorMapperTest`, `AuthInterceptorTest`
- `feature:home` — `HomeViewModelTest`
- `feature:tasks` — `TaskRepositoryTest`, `TasksViewModelTest`
- `app` — `DeepLinkTest`, `PushParserTest`

## Contract parity note

`MobileAuthTokenResponse` / `MobileAuthExchangeBody` are declared app-locally
(theme8 single opaque token) mirroring the `CONSUMED-SHAPE` block in `contract.ts`;
they collapse to the frozen type once MO3 emits it via OpenAPI. Never re-declare
them in `@dub/types` (owner = foundation-contracts / MO3).
