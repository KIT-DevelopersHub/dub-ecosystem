// InboxViewModel (S7) — the notification inbox. MVI/UDF over MobileBffClient:
// loading / content / error with stale-while-error (§6). mark-read and mark-all-read
// are applied optimistically (set readAt locally) and rolled back on failure, in the
// spirit of the task optimistic-locking pattern (a read receipt is not versioned, so
// a failure simply reverts the local flag).
package jp.developershub.dub.mo2.feature.inbox

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import jp.developershub.dub.mo2.core.model.InboxItem
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import jp.developershub.dub.mo2.core.network.MobileBffClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface InboxUiState {
    data object Loading : InboxUiState
    data class Content(val items: List<InboxItem>, val unreadCount: Int, val isEmpty: Boolean) : InboxUiState
    data class Error(val error: AppError, val cached: List<InboxItem>?) : InboxUiState
}

class InboxViewModel(
    private val client: MobileBffClient,
    private val now: () -> String = { java.time.Instant.now().toString() },
) : ViewModel() {

    private val _uiState = MutableStateFlow<InboxUiState>(InboxUiState.Loading)
    val uiState: StateFlow<InboxUiState> = _uiState.asStateFlow()

    private var items: List<InboxItem> = emptyList()
    private var lastGood: List<InboxItem>? = null

    fun load() = fetch()
    fun refresh() = fetch()

    private fun fetch() {
        viewModelScope.launch {
            if (_uiState.value !is InboxUiState.Content) _uiState.value = InboxUiState.Loading
            try {
                items = client.getInbox().items
                lastGood = items
                emitContent()
            } catch (e: AppErrorException) {
                _uiState.value = InboxUiState.Error(e.appError, lastGood)
            } catch (e: Throwable) {
                _uiState.value = InboxUiState.Error(AppError.Server("UNKNOWN", null), lastGood)
            }
        }
    }

    fun markRead(id: String) {
        val previous = items
        if (items.none { it.id == id && it.readAt == null }) return // already read / absent
        items = items.map { if (it.id == id && it.readAt == null) it.copy(readAt = now()) else it }
        emitContent()
        viewModelScope.launch {
            try {
                client.markRead(id)
            } catch (_: Throwable) {
                items = previous // revert the local read flag
                emitContent()
            }
        }
    }

    fun markAllRead() {
        val previous = items
        val stamp = now()
        items = items.map { if (it.readAt == null) it.copy(readAt = stamp) else it }
        emitContent()
        viewModelScope.launch {
            try {
                client.markAllRead()
            } catch (_: Throwable) {
                items = previous
                emitContent()
            }
        }
    }

    private fun emitContent() {
        val unread = items.count { it.readAt == null }
        _uiState.value = InboxUiState.Content(items, unread, isEmpty = items.isEmpty())
    }
}
