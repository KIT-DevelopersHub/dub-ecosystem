# @dub/fe8-public-pages

FE8 — DevelopersHub public site: org HP, event LPs (北陸ITカンファレンス), sponsor intake.
See design `設計_P0a/frontend/FE8-public-pages.md` + P0b freeze summary.

## Stack (frozen)

- **Astro SSG** + TypeScript + Content Collections (P0b decision 5: "FE8 のみ Astro SSG").
- Styling: `@dub/tokens/css` (`--dub-*` CSS variables only, React-free). **Light-fixed** — `data-theme` is never set, so dark rules stay inert (design §1).
- Zero client JS except the single interactive island `InquiryForm` (design §2-2 / §7-3).

## Boundaries

- Owns all anonymous/public pages + repo Content Collections (the **only** canonical source for events/news/sponsor plans — no public GET API, no double-canonicalization with event-service; design §3).
- Owns no D1 tables, no queues. The one dynamic dependency is the gateway public receiver `POST /api/v1/public/inquiries`, typed against the **frozen** `@dub/types` gateway namespace.

## Routes (11 + 404 + sitemap)

`/` `/about` `/news` `/news/[slug]` `/contact` `/events` `/events/[slug]` `/sponsors` `/sponsors/inquiry` `/code-of-conduct` `/privacy`, plus `sitemap.xml`, `robots.txt`, `404`.

## Commands

```
pnpm --filter ./apps/fe8-public-pages build   # astro build → dist/ (static)
pnpm --filter ./apps/fe8-public-pages test    # vitest (framework-agnostic lib + schemas)
pnpm --filter ./apps/fe8-public-pages dev      # astro dev
```

Foundation packages must be built first for `@dub/*` subpath resolution (`pnpm -r --filter ./packages/* build`); CI's turbo `^build` handles this. Unit tests resolve `@dub/*` to source via `vite-tsconfig-paths` and need no prior build.

## Build-time env

All `PUBLIC_*` vars are inlined into the static bundle at `astro build` time, so they must contain **no secrets** (Turnstile siteverify + rate-limit stay gateway-side).

- `PUBLIC_GATEWAY_ORIGIN` — gateway origin for the inquiry POST (`POST <origin>/api/v1/public/inquiries`). **Empty/unset = same-origin.** When set it must be a bare `http(s)` origin (`scheme://host[:port]`, no path, no trailing slash); `resolveGatewayOrigin` (in `lib/inquiry-client.ts`) normalizes it — any path/trailing slash is dropped, and a non-empty value that fails to parse falls back to same-origin (the `InquiryForm` island logs a `console.warn` so the misconfiguration is visible). Example: `PUBLIC_GATEWAY_ORIGIN=https://api.developershub.jp`.
- `PUBLIC_TURNSTILE_SITE_KEY` — Cloudflare Turnstile site key (public, not a secret). When set the widget script loads and renders; the token is verified gateway-side. Empty = the widget is inert (dev/preview only).

Local setup: create `apps/fe8-public-pages/.env` with these two keys (both may be blank for a same-origin, Turnstile-less dev build).

## Contract note (frozen vs P0a draft)

The frozen `@dub/types` `PublicInquiryRequest` is minimal — `{ kind: general|sponsor|press, name, email, message, turnstileToken }` → `{ accepted }`. The P0a draft's richer fields (`organization`, `eventSlug`, `sponsorTier`, `idempotencyKey`) and `{ inquiryId, receivedAt }` response are **not** in the frozen contract; FE8 conforms to the frozen package. The idempotency key (design §8 旧#8b) is carried as the `x-dub-idempotency-key` request header (kept out of the body so it stays contract-exact) and reused across retries so the gateway can dedup.

## STUB / awaiting cross-unit wiring

- Turnstile widget renders from the site key; real siteverify + rate-limit + `public.inquiry.received` publish are gateway-side (9-B/C/E integration wave).
- Sponsor deck PDF (`/sponsor-deck.pdf`) is a placeholder link (design §8 旧#8: Pages asset direct-place).
- OGP: single static default image; per-slug OGP generation deferred to P1 (design §2-1).
- Hosting/deploy path (Pages vs Workers static assets) is design §8 未決 #1/#2 — Astro output is portable either way.
