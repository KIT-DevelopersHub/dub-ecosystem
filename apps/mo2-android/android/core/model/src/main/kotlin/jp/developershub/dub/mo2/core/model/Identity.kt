// Mirror of the parts of @dub/types `identity` namespace MO2 consumes
// (packages/types/src/identity.ts). PermissionKey is the frozen 23-key catalog;
// MO2 receives effective capabilities in MobileEventOverviewResponse.
package jp.developershub.dub.mo2.core.model

// PermissionKey is a closed union of 23 `<domain>:<action>` keys in the frozen
// contract. Represented here as a String (the wire form) with the catalog listed
// for reference; the server is the authority (default deny).
typealias PermissionKey = String

object PermissionCatalog {
    val KEYS: List<PermissionKey> = listOf(
        "identity:read", "identity:admin",
        "event:read", "event:write", "event:admin",
        "task:read", "task:write", "task:delete",
        "file:read", "file:write", "file:admin",
        "notif:send", "notif:admin",
        "mail:send", "mail:read", "mail:admin",
        "chat:create", "chat:moderate",
        "infra:read", "infra:deploy", "infra:dns", "infra:admin",
        "audit:read",
    )
}
