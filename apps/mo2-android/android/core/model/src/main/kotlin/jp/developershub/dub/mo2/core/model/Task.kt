// Mirror of @dub/types `task` namespace (packages/types/src/task.ts).
// Optimistic-locked CRUD; the status transition table is the single source
// shared with server validation + FE4 UI activation.
package jp.developershub.dub.mo2.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class TaskStatus {
    @SerialName("todo") TODO,
    @SerialName("in_progress") IN_PROGRESS,
    @SerialName("blocked") BLOCKED,
    @SerialName("done") DONE,
    @SerialName("cancelled") CANCELLED,
}

@Serializable
enum class TaskPriority {
    @SerialName("low") LOW,
    @SerialName("medium") MEDIUM,
    @SerialName("high") HIGH,
    @SerialName("urgent") URGENT,
}

@Serializable
enum class TaskOrigin {
    @SerialName("internal") INTERNAL,
    @SerialName("github") GITHUB,
}

// Status transition table — mirror of TASK_STATUS_TRANSITIONS. Used by the UI to
// activate only legal status changes (server re-validates authoritatively).
val TASK_STATUS_TRANSITIONS: Map<TaskStatus, List<TaskStatus>> = mapOf(
    TaskStatus.TODO to listOf(TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED, TaskStatus.DONE, TaskStatus.CANCELLED),
    TaskStatus.IN_PROGRESS to listOf(TaskStatus.TODO, TaskStatus.BLOCKED, TaskStatus.DONE, TaskStatus.CANCELLED),
    TaskStatus.BLOCKED to listOf(TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED),
    TaskStatus.DONE to listOf(TaskStatus.IN_PROGRESS),
    TaskStatus.CANCELLED to listOf(TaskStatus.TODO),
)

@Serializable
data class Task(
    val id: TaskId,
    val eventId: EventId,
    val title: String,
    val description: String? = null,
    val status: TaskStatus,
    val priority: TaskPriority,
    val assigneeId: UserId? = null,
    val dueAt: ISODateTime? = null,
    val origin: TaskOrigin,
    val archivedAt: ISODateTime? = null,
    val createdAt: ISODateTime,
    val updatedAt: ISODateTime,
    val version: Int, // Versioned (D4): mismatch -> 409 TASK_VERSION_CONFLICT
)

@Serializable
data class TaskSummary(
    val id: TaskId,
    val title: String,
    val status: TaskStatus,
    val assigneeId: UserId? = null,
)

@Serializable
data class UpdateTaskRequest(
    val version: Int, // Versioned (D4)
    val title: String? = null,
    val description: String? = null,
    val status: TaskStatus? = null,
    val priority: TaskPriority? = null,
    val assigneeId: UserId? = null,
    val dueAt: ISODateTime? = null,
)
