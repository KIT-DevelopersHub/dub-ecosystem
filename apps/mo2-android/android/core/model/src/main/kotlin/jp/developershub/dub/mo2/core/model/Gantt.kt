// Mirror of @dub/types `gantt` namespace (packages/types/src/gantt.ts).
// gantt-service owns this namespace; the chart is a read model over task/event
// and the view state (zoom + collapsed rows) is a per-user pref (S11). Keep field
// names identical to the frozen contract (OpenAPI-gen target parity).
package jp.developershub.dub.mo2.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class GanttZoom {
    @SerialName("day") DAY,
    @SerialName("week") WEEK,
    @SerialName("month") MONTH,
}

@Serializable
data class GanttRow(
    val taskId: TaskId,
    val title: String,
    val startsAt: ISODateTime? = null,
    val endsAt: ISODateTime? = null,
    val progressPercent: Int, // 0-100 (done=100/else=0 in P0)
    val assigneeId: UserId? = null,
)

@Serializable
data class GanttDependencyLine(
    val id: String, // composite key `${taskId}->${dependsOnId}`
    val fromTaskId: TaskId,
    val toTaskId: TaskId,
    val type: String = "FS", // P0 constant fill
    val lagDays: Int = 0, // P0 constant 0
)

@Serializable
data class GanttChartDTO(
    val eventId: EventId,
    val rows: List<GanttRow>,
    val dependencies: List<GanttDependencyLine>,
)

@Serializable
data class GanttViewState(
    val eventId: EventId,
    val zoom: GanttZoom,
    val collapsedTaskIds: List<TaskId>,
)

@Serializable
data class PutGanttViewRequest(
    val zoom: GanttZoom,
    val collapsedTaskIds: List<TaskId>,
)
