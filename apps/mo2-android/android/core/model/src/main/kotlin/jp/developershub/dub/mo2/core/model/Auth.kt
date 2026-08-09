// Mirror of @dub/types `auth` namespace (packages/types/src/auth.ts) plus the
// mobile auth token response. NOTE (parity with contract.ts CONSUMED-SHAPE):
// MobileAuthTokenResponse / MobileAuthExchangeBody are not yet in the frozen
// `mobile` namespace; they are declared app-locally (theme8 single opaque token)
// and collapse to the frozen type once MO3 emits it via OpenAPI. Never re-declare
// these in @dub/types (owner = foundation-contracts / MO3).
package jp.developershub.dub.mo2.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class AuthClient {
    @SerialName("web") WEB,
    @SerialName("mobile") MOBILE,
}

@Serializable
data class SessionInfo(
    val userId: UserId,
    val client: AuthClient,
    val sessionExpiresAt: EpochMs, // epoch-ms exception (theme10)
)

// ---- CONSUMED-SHAPE (not yet in frozen @dub/types mobile ns) ----
@Serializable
data class MobileAuthTokenResponse(
    val token: String, // single opaque Bearer session token (NOT a JWT, NOT 2-token)
    val refreshToken: String? = null, // mobile refresh (rotated on use; theme8)
    val session: SessionInfo,
)

@Serializable
data class MobileAuthExchangeBody(
    val code: String,
    val platform: MobilePlatform, // AppAuth/PKCE handled natively; code posted here
)

@Serializable
data class MobileAuthRefreshBody(
    val refreshToken: String,
)
