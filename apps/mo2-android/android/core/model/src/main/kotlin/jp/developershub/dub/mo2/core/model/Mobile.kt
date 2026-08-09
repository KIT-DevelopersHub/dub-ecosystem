// Mirror of @dub/types `mobile` namespace (packages/types/src/mobile.ts).
// MO3 mobile-bff owns this namespace; it is the OpenAPI generation source.
// Sync/mutation shapes are STUB in the frozen contract and omitted here until
// MO3's later wave lands them.
package jp.developershub.dub.mo2.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class MobilePlatform {
    @SerialName("ios") IOS,
    @SerialName("android") ANDROID,
}

@Serializable
data class MobileHomeResponse(
    val upcomingEvents: List<EventSummary>,
    val myTasks: List<TaskSummary>,
    val unreadCount: Int,
)

@Serializable
data class MobileEventOverviewResponse(
    val event: EventSummary,
    val capabilities: List<PermissionKey>,
)

@Serializable
data class RegisterDeviceRequest(
    val platform: MobilePlatform,
    val pushToken: String,
)

@Serializable
data class RegisterDeviceResponse(
    val deviceId: String,
)

@Serializable
data class DeviceDto(
    val id: String,
    val platform: MobilePlatform,
    val registeredAt: ISODateTime,
)

@Serializable
data class MobilePushPayload(
    val title: String,
    val body: String,
    val data: Map<String, String>? = null,
)
