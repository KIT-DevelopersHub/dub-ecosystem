// MO2 app config — mirror of config.ts. Client-only; talks to MO3 mobile-bff
// exclusively (theme14). α small-decisions applied by default (P0b judgment46):
// invite-only identity, origin=github, brand color seed. UI/const defaults only —
// the server contract owns the truth.
package jp.developershub.dub.mo2.core.common

object MoConfig {
    /** MO3 mobile-bff public face (theme14: separate Worker). */
    const val MO3_BASE_URL = "https://m-api.developershub.jp"

    /** Frozen mobile prefix (common.MOBILE_API_PREFIX = "/m/v1"). */
    const val MOBILE_API_PREFIX = "/m/v1"

    /** App Links canonical host + custom-scheme fallback (theme8/14; devhub:// retired). */
    const val APP_LINK_HOST = "developershub.jp"
    const val DEEP_LINK_SCHEME = "dub"

    /** This platform tag posted on auth exchange / device registration. */
    const val MOBILE_PLATFORM = "android"

    // ---- α defaults (P0b judgment46 — AI discretion, low rework risk) ----
    const val INVITE_ONLY = true
    const val DEFAULT_TASK_ORIGIN = "github"
    const val BRAND_COLOR_SEED = 0xFF3A6EA5.toInt() // Material3 seed; FE1 tokens override later
    const val MIN_SDK = 26 // §8 #9
}
