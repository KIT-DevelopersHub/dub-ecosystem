// TaskDetailViewModel (S6) — loads a single Task (with its version for optimistic
// locking) and drives status changes through the shared TaskRepository so the
// list cache stays consistent. 409 conflicts surface as a one-shot effect.
package jp.developershub.dub.mo2.feature.tasks

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import jp.developershub.dub.mo2.core.model.Task
import jp.developershub.dub.mo2.core.model.TaskStatus
import jp.developershub.dub.mo2.core.model.TaskSummary
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import jp.developershub.dub.mo2.core.network.MobileBffClient
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

sealed interface TaskDetailUiState {
    data object Loading : TaskDetailUiState
    data class Content(val task: Task) : TaskDetailUiState
    data class Error(val error: AppError) : TaskDetailUiState
}

class TaskDetailViewModel(
    private val taskId: String,
    private val client: MobileBffClient,
    private val repository: TaskRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow<TaskDetailUiState>(TaskDetailUiState.Loading)
    val uiState: StateFlow<TaskDetailUiState> = _uiState.asStateFlow()

    private val effects = Channel<TaskEffect>(Channel.BUFFERED)
    val effect: Flow<TaskEffect> = effects.receiveAsFlow()

    fun load() {
        viewModelScope.launch {
            _uiState.value = TaskDetailUiState.Loading
            try {
                val task = client.getTask(taskId)
                // Seed the shared cache so an optimistic updateStatus has a base
                // to roll back to even when the list has not been loaded yet.
                repository.put(TaskSummary(task.id, task.title, task.status, task.assigneeId))
                _uiState.value = TaskDetailUiState.Content(task)
            } catch (e: AppErrorException) {
                _uiState.value = TaskDetailUiState.Error(e.appError)
            } catch (e: Throwable) {
                _uiState.value = TaskDetailUiState.Error(AppError.Server("UNKNOWN", null))
            }
        }
    }

    fun changeStatus(status: TaskStatus, baseVersion: Int) {
        viewModelScope.launch {
            when (val result = repository.updateStatus(taskId, status, baseVersion)) {
                is TaskUpdateResult.Ok -> _uiState.value = TaskDetailUiState.Content(result.task)
                is TaskUpdateResult.Conflict -> {
                    effects.send(TaskEffect.Conflict(taskId, result.serverVersion))
                    load() // refetch authoritative state so version is fresh
                }
                is TaskUpdateResult.Failure -> effects.send(TaskEffect.Failure(taskId, result.error))
            }
        }
    }
}
