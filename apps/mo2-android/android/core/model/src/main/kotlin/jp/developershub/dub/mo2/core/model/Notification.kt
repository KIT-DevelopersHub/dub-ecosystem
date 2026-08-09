// Mirror of @dub/types `notification` namespace (packages/types/src/notification.ts).
package jp.developershub.dub.mo2.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class NotificationChannel {
    @SerialName("in_app") IN_APP,
    @SerialName("email") EMAIL,
    @SerialName("chat") CHAT,
    @SerialName("push") PUSH,
}

// NotificationType is an open vocabulary (string) in the frozen contract.
typealias NotificationType = String

@Serializable
data class InboxItem(
    val id: NotificationId,
    val type: NotificationType,
    val title: String,
    val body: String,
    val readAt: ISODateTime? = null,
    val createdAt: ISODateTime,
    val resourceType: String? = null,
    val resourceId: String? = null,
)

// ListInboxResponse = Paginated<InboxItem> (frozen alias).
typealias ListInboxResponse = Paginated<InboxItem>

@Serializable
data class PreferenceEntry(
    val type: NotificationType,
    val channels: List<NotificationChannel>,
)
