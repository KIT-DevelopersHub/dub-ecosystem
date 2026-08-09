// TasksViewModel (S5/S6) — MVI/UDF over TaskRepository. Holds the my-tasks list
// UiState and drives optimistic status changes, surfacing the 409 conflict /
// failure outcomes as one-shot effects (a snackbar + refreshed value; theme3 D4).
// The list itself flows straight from the repository StateFlow so the optimistic
// apply / rollback is observed by Compose without extra plumbing.
package jp.developershub.dub.mo2.feature.tasks

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import jp.developershub.dub.mo2.core.model.TaskStatus
import jp.developershub.dub.mo2.core.model.TaskSummary
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

sealed interface TasksUiState {
    data object Loading : TasksUiState
    data class Content(val tasks: List<TaskSummary>, val isEmpty: Boolean) : TasksUiState
    data class Error(val error: AppError) : TasksUiState
}

sealed interface TaskEffect {
    /** Optimistic change rejected by the server; list already refetched. */
    data class Conflict(val taskId: String, val serverVersion: Int?) : TaskEffect
    data class Failure(val taskId: String, val error: AppError) : TaskEffect
}

class TasksViewModel(
    private val repository: TaskRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow<TasksUiState>(TasksUiState.Loading)
    val uiState: StateFlow<TasksUiState> = _uiState.asStateFlow()

    private val effects = Channel<TaskEffect>(Channel.BUFFERED)
    val effect: Flow<TaskEffect> = effects.receiveAsFlow()

    init {
        // Mirror the repository cache into content state (optimistic + committed).
        viewModelScope.launch {
            repository.tasks.collect { list ->
                if (_uiState.value !is TasksUiState.Error || list.isNotEmpty()) {
                    _uiState.value = TasksUiState.Content(list, isEmpty = list.isEmpty())
                }
            }
        }
    }

    fun load() = refresh()

    fun refresh() {
        viewModelScope.launch {
            if (_uiState.value !is TasksUiState.Content) _uiState.value = TasksUiState.Loading
            try {
                repository.refreshMyTasks()
            } catch (e: AppErrorException) {
                _uiState.value = TasksUiState.Error(e.appError)
            } catch (e: Throwable) {
                _uiState.value = TasksUiState.Error(AppError.Server("UNKNOWN", null))
            }
        }
    }

    fun changeStatus(id: String, status: TaskStatus, baseVersion: Int) {
        viewModelScope.launch {
            when (val result = repository.updateStatus(id, status, baseVersion)) {
                is TaskUpdateResult.Ok -> Unit // committed; list already updated
                is TaskUpdateResult.Conflict ->
                    effects.send(TaskEffect.Conflict(id, result.serverVersion))
                is TaskUpdateResult.Failure ->
                    effects.send(TaskEffect.Failure(id, result.error))
            }
        }
    }
}
