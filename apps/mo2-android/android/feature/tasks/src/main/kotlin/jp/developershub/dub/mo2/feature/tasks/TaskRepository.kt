// TaskRepository — read cache (StateFlow) + single-source = MO3 (§2-2). Task
// write is one online PATCH with optimistic locking: apply optimistically,
// commit on 200, rollback + refetch on 409 (§6 / theme3 D4). 1:1 port of
// task-repository.ts; the Flow<List<TaskSummary>> boundary a Compose state
// collects replaces the JS listener set.
package jp.developershub.dub.mo2.feature.tasks

import jp.developershub.dub.mo2.core.model.Task
import jp.developershub.dub.mo2.core.model.TaskStatus
import jp.developershub.dub.mo2.core.model.TaskSummary
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import jp.developershub.dub.mo2.core.network.MobileBffClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface TaskUpdateResult {
    data class Ok(val task: Task) : TaskUpdateResult
    /** rolled back + refetched. */
    data class Conflict(val serverVersion: Int?) : TaskUpdateResult
    /** rolled back. */
    data class Failure(val error: AppError) : TaskUpdateResult
}

class TaskRepository(
    private val client: MobileBffClient,
) {
    // Insertion-ordered read cache; emitted as an immutable snapshot list.
    private val cache = LinkedHashMap<String, TaskSummary>()
    private val _tasks = MutableStateFlow<List<TaskSummary>>(emptyList())
    val tasks: StateFlow<List<TaskSummary>> = _tasks.asStateFlow()

    private fun emit() {
        _tasks.value = cache.values.toList()
    }

    /** Replace cache from the server list (pull-to-refresh / TTL revalidate). */
    suspend fun refreshMyTasks() {
        val page = client.getMyTasks()
        cache.clear()
        page.items.forEach { cache[it.id] = it }
        emit()
    }

    /** Test/seed hook to prime the read cache (replaces contents). */
    fun seed(tasks: List<TaskSummary>) {
        cache.clear()
        tasks.forEach { cache[it.id] = it }
        emit()
    }

    /**
     * Insert/refresh a single entry without clearing the cache. Used when a task
     * is opened via deep link before the list has loaded, so an optimistic
     * updateStatus has a base value to roll back to.
     */
    fun put(task: TaskSummary) {
        cache[task.id] = task
        emit()
    }

    /**
     * Optimistic status change. baseVersion is the version the user saw.
     * Success -> commit; 409 -> rollback then refetch latest; other -> rollback.
     */
    suspend fun updateStatus(id: String, status: TaskStatus, baseVersion: Int): TaskUpdateResult {
        val previous = cache[id]
            ?: return TaskUpdateResult.Failure(AppError.Server("NOT_IN_CACHE", null))

        // 1. optimistic apply
        cache[id] = previous.copy(status = status)
        emit()

        return try {
            // 2. single online PATCH
            val updated = client.updateTaskStatus(id, status, baseVersion)
            // 3a. commit authoritative server state
            cache[id] = updated.toSummary()
            emit()
            TaskUpdateResult.Ok(updated)
        } catch (err: Throwable) {
            val appError = (err as? AppErrorException)?.appError
                ?: AppError.Server("UNKNOWN", null)

            // 3b. rollback optimistic UI first
            cache[id] = previous
            emit()

            if (appError is AppError.Conflict) {
                // refetch latest so the user re-decides against fresh state
                try {
                    val fresh = client.getTask(id)
                    cache[id] = fresh.toSummary()
                    emit()
                } catch (_: Throwable) {
                    // keep the rolled-back value if refetch also fails (offline etc.)
                }
                TaskUpdateResult.Conflict(appError.serverVersion)
            } else {
                TaskUpdateResult.Failure(appError)
            }
        }
    }
}

private fun Task.toSummary(): TaskSummary =
    TaskSummary(id = id, title = title, status = status, assigneeId = assigneeId)
