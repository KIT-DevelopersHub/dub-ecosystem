// Mirror of @dub/types `common` namespace (packages/types/src/common.ts).
// Shared primitives: prefix-ULID string ids (D1, no brand), pagination (D3),
// optimistic locking (D4), declared constants (D5). Generated-target parity —
// keep field names identical to the frozen contract.
package jp.developershub.dub.mo2.core.model

import kotlinx.serialization.Serializable

// ---- ids (D1: prefix-ULID plain string) ----
typealias UserId = String
typealias OrgId = String
typealias RoleId = String
typealias EventId = String
typealias ActionId = String
typealias TaskId = String
typealias NotificationId = String
typealias RequestId = String

// ---- time (D2) ----
typealias ISODateTime = String // ISO8601 UTC, e.g. "2026-08-09T05:00:00Z"
typealias EpochMs = Long // theme10 exception: session-expiry fields carry epoch-ms

// ---- pagination (D3: opaque cursor, offset paging forbidden) ----
@Serializable
data class Paginated<T>(
    val items: List<T>,
    val nextCursor: String? = null, // null = end of results
)

// ---- constants (D5) ----
object DubConstants {
    const val API_PREFIX = "/api/v1"
    const val MOBILE_API_PREFIX = "/m/v1"
    const val DUB_DEFAULT_ORG_ID = "org_devhub"
}
