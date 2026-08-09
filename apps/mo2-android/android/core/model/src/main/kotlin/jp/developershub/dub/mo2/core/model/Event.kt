// Mirror of @dub/types `event` namespace (packages/types/src/event.ts).
// "Event > Action" hierarchy is absolute. MO2 consumes the summary shape.
package jp.developershub.dub.mo2.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class EventPhase {
    @SerialName("planning") PLANNING,
    @SerialName("preparing") PREPARING,
    @SerialName("open") OPEN,
    @SerialName("live") LIVE,
    @SerialName("wrapup") WRAPUP,
    @SerialName("closed") CLOSED,
}

@Serializable
data class EventSummary(
    val id: EventId,
    val title: String,
    val phase: EventPhase,
    val startsAt: ISODateTime? = null,
)

@Serializable
data class ActionSummary(
    val id: ActionId,
    val eventId: EventId,
    val kind: String,
    val title: String,
)
