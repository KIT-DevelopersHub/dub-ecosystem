# MO1 iOS — native SwiftUI app (`apps/mo1-ios/ios/`)

The production **Swift 5.10+ / SwiftUI / iOS 17+** app for the MO1 participant/staff
front. It is the native counterpart of the TypeScript contract-reference layer in
`apps/mo1-ios/src/` (which stays the frozen, vitest-locked spec). Every module
here maps 1:1 to that reference and to the design refs it cites.

> This package is a **Swift Package (SwiftPM)**, not part of the pnpm/turbo
> monorepo — it cannot build under vitest. It builds and unit-tests with the
> Swift toolchain alone (no Xcode project required), and also declares `.macOS`
> so `swift test` runs off-device / in CI.

## Layering (MVVM + Repository)

| Target | Contents |
|---|---|
| `Mo1Core` | Contracts (mirrors `@dub/types` consumed subset), `Transport`/`URLSessionTransport`, `MobileApiClient`, `TokenStore` + `KeychainTokenStore`, `DubClientError`/`ErrorMapper`, and the pure domain (`Optimistic`, `HomeReducer`, `DeepLink`, `Push`, `SwrCache`, `Capabilities`, `PKCE`). No UI. |
| `Mo1UI` | `ObservableObject` ViewModels (`Home`, `TaskDetail`, `Login`), SwiftUI views (S1 login, S2 home, task detail), `WebAuthService` (ASWebAuthenticationSession), `AppSession` composition root. |
| `Mo1App` | `@main` app entry → `RootView`. |

## TS reference ⇄ Swift map

| `apps/mo1-ios/src/*.ts` | Swift |
|---|---|
| `api-client.ts` | `Mo1Core/Networking/ApiClient.swift` |
| `errors.ts` | `Mo1Core/Errors/DubClientError.swift` |
| `token-store.ts` | `Mo1Core/Networking/TokenStore.swift` + `KeychainTokenStore.swift` |
| `transport.ts` | `Mo1Core/Networking/Transport.swift` |
| `optimistic.ts` | `Mo1Core/Domain/Optimistic.swift` + `TaskDetailViewModel` |
| `home.ts` | `Mo1Core/Domain/HomeReducer.swift` + `HomeViewModel` |
| `deeplink.ts` / `push.ts` | `Mo1Core/Domain/DeepLink.swift` / `Push.swift` |
| `cache.ts` | `Mo1Core/Domain/Cache.swift` |
| `capabilities.ts` | `Mo1Core/Domain/Capabilities.swift` |

## Cross-cutting behaviour (identical to the TS reference)

- **Bearer + single silent refresh** (design §6 "1回性"): 401 → one
  `/m/v1/auth/refresh` (current token as Bearer, theme8) → retry **once**;
  still-401 or refresh-fail clears the Keychain and routes to S1. Concurrent
  401s share one in-flight refresh.
- **Semi-open error model** (§6): common codes get a typed `kind`; open service
  codes classify by suffix/status; anything unmodelled → `.unknown` (never crashes).
- **Optimistic task UI** (§5 S5): PATCH carries `version`; 409 → rollback to snapshot + refetch flag.
- **All traffic to `/m/v1/*`** via `MOBILE_API_PREFIX`; MO3 is the only peer.

## Build & test

```
cd apps/mo1-ios/ios
swift test     # 58 unit tests (Core + ViewModel + ErrorMapper), all green
swift build    # compiles Core + UI + the @main app
```

For a real iOS build, open the package in Xcode and select an iOS 17 simulator;
`Mo1App` is the run target.

## Placeholders / next wave (not P0)

- PKCE login is wired (`PKCE` + `WebAuthService`) but the authorize/token
  endpoints are the client-local placeholder shapes — swap for the generated
  `mobile.MobileAuthSession` once MO3 freezes the exchange/refresh envelope
  (see `apps/mo1-ios/README.md` "Contract gap").
- `KeychainTokenStore` is the production store; tests use `InMemoryTokenStore`.
- Push registration/APNs dispatch, SwiftData persistence, and the gantt/chat
  screens land in the mobile implementation wave.
