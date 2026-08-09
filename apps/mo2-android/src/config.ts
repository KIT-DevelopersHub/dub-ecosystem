// MO2 app config. Client-only; talks to MO3 mobile-bff exclusively (theme14).
// α small-decisions applied by default (P0b judgment46): invite-only identity,
// origin=github, brand color initial value. These are UI/const defaults only —
// the server contract owns the truth.
import { common } from "@dub/types";

export const MOBILE_PLATFORM = "android" as const;

/** MO3 mobile-bff public face (theme14: m-api.developershub.jp, separate Worker). */
export const MO3_BASE_URL = "https://m-api.developershub.jp";

/** Frozen mobile prefix (common.MOBILE_API_PREFIX = "/m/v1"). */
export const MOBILE_API_PREFIX = common.MOBILE_API_PREFIX;

/** App Links canonical host + custom-scheme fallback (theme8/14; devhub:// retired). */
export const APP_LINK_HOST = "developershub.jp";
export const DEEP_LINK_SCHEME = "dub";

/** α defaults (P0b judgment46 — AI discretion, low rework risk). */
export const APP_DEFAULTS = {
  inviteOnly: true, // identity invite-only
  defaultTaskOrigin: "github" as const, // origin=github accepted default
  brandColorSeed: "#3A6EA5", // Material3 seed; FE1 tokens.json override later (MO2 owns conversion)
  minSdk: 26, // §8 #9 (MO2-internal, target latest)
} as const;
