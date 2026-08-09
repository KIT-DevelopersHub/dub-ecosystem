# @dub/mo1-ios — MO1 iOS front (P0 contract-consumption layer)

Owner unit: **MO1** (iOS SwiftUI participant/staff app). Design source of truth:
`設計_P0a/mobile/MO1-ios.md` + `設計_P0b/_P0b凍結サマリ`.

## What ships in P0 (this package)

The **production app is Swift 5.10+ / SwiftUI / iOS 17+** (MVVM + Repository,
SwiftData cache, ASWebAuthenticationSession PKCE, APNs). That app cannot run
inside this pnpm/vitest monorepo, so P0 here is the **TypeScript reference /
contract-consumption layer**: the exact cross-cutting logic the Swift ApiClient
and ViewModels must implement, written against the frozen `@dub/types` `mobile`
namespace (MO3 正本) and `@dub/errors`, and locked green by vitest.

This de-risks the Swift wave and freezes the consumed contract. Every module
here maps 1:1 to a Swift counterpart:

| TS module | Swift counterpart | Design ref |
|---|---|---|
| `api-client.ts` | `ApiClient` (URLSession) | §2-2, §6 |
| `errors.ts` | 準開放 `DubError` enum | §6 |
| `token-store.ts` | Keychain wrapper | §1, §3 |
| `optimistic.ts` | task状態変更ViewModel | §5 S5, §6 |
| `push.ts` / `deeplink.ts` | PushKit routing | §2-2, §7 Push |
| `home.ts` | HomeViewModel (S2) | §2-1 |
| `cache.ts` | SwiftData SWR cache | §1, §8-3 |
| `capabilities.ts` | UI 出し分け | §6 |

The Swift package (Xcode project, DesignKit from FE1 `tokens.json`, OpenAPI→swift5
generated Models) lands in the mobile implementation wave (9-D GO'd).

## Cross-cutting behaviour locked here

- **Bearer + single silent refresh**: 401 → one `/m/v1/auth/refresh` (current
  token as Bearer, theme8) → retry **once**; still-401 or refresh-fail clears the
  Keychain and routes to S1. Concurrent 401s share one in-flight refresh.
- **Semi-open error model**: common codes get a typed `kind`; open service codes
  (`TASK_VERSION_CONFLICT`, `MOBILE_SYNC_CURSOR_EXPIRED`, …) classify by suffix/
  status; anything unmodelled → `unknown` (never crashes).
- **Optimistic task UI**: PATCH carries `version`; 409 → rollback to snapshot.
- **All traffic to `/m/v1/*`** via `common.MOBILE_API_PREFIX`; MO3 is the only
  peer (no gateway / internal-18 knowledge).

## Contract gap (feeds back to MO3 / #18)

The frozen `mobile` namespace does **not yet** publish the auth exchange/refresh
**response** envelope (only `auth.MobileExchangeRequest` exists). `api-client.ts`
uses a client-local `MobileAuthSession { token, session: auth.SessionInfo }` as a
placeholder — **replace with the generated `mobile.MobileAuthSession` once MO3
freezes it.** Also absent vs design §2-3: `MobileHomeResponse.partialErrors` /
`syncCursor`, `InboxItem`-based `MobileInboxResponse`, `capabilities` on the
event detail (current frozen type is `MobileEventOverviewResponse`). This layer
consumes the **frozen** shapes as-is (no手書き再定義); the deltas are MO3's call.

## Run

```
pnpm --filter ./apps/mo1-ios test        # 45 tests
pnpm --filter ./apps/mo1-ios typecheck
```

## Deferred (per design §8 / P0b, not in P0)

- S6 gant / S8 chat screens (P0 out; chat waits on 9-C RT DO + WS RT-direct).
- `/sync` + `/mutations` offline write (STUB, MO3-owned, later wave).
- APNs live dispatch (notification-service → MO3 → APNs; 9-E push timing).
