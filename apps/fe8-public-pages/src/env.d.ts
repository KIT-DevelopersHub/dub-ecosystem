/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Gateway origin for the inquiry POST (empty = same-origin). Build-time. */
  readonly PUBLIC_GATEWAY_ORIGIN?: string;
  /** Cloudflare Turnstile site key (design §5, injected at build). */
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
