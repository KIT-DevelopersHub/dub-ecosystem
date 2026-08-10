// ChannelListViewModel (S10) — MVI over the channel list, and ChatViewModel — the
// per-channel thread. The message list flows straight from the ChatRepository
// StateFlow so an optimistic send / realtime reconcile is observed by Compose
// without extra plumbing; a failed send surfaces as a one-shot effect. Realtime is
// connected for the channel's lifetime and disconnected in onCleared.
package jp.developershub.dub.mo2.feature.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import jp.developershub.dub.mo2.core.model.ChatChannel
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

// ---- channel list ----

sealed interface ChannelListUiState {
    data object Loading : ChannelListUiState
    data class Content(val channels: List<ChatChannel>, val isEmpty: Boolean) : ChannelListUiState
    data class Error(val error: AppError) : ChannelListUiState
}

class ChannelListViewModel(
    private val repository: ChatRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow<ChannelListUiState>(ChannelListUiState.Loading)
    val uiState: StateFlow<ChannelListUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            repository.channels.collect { list ->
                if (_uiState.value !is ChannelListUiState.Error || list.isNotEmpty()) {
                    _uiState.value = ChannelListUiState.Content(list, isEmpty = list.isEmpty())
                }
            }
        }
    }

    fun load() {
        viewModelScope.launch {
            if (_uiState.value !is ChannelListUiState.Content) _uiState.value = ChannelListUiState.Loading
            try {
                repository.loadChannels()
            } catch (e: AppErrorException) {
                _uiState.value = ChannelListUiState.Error(e.appError)
            } catch (e: Throwable) {
                _uiState.value = ChannelListUiState.Error(AppError.Server("UNKNOWN", null))
            }
        }
    }
}

// ---- per-channel thread ----

sealed interface ChatThreadUiState {
    data object Loading : ChatThreadUiState
    data class Content(val entries: List<ChatMessageEntry>) : ChatThreadUiState
    data class Error(val error: AppError) : ChatThreadUiState
}

sealed interface ChatEffect {
    data class SendFailed(val localId: String, val error: AppError) : ChatEffect
}

class ChatViewModel(
    private val repository: ChatRepository,
    private val channelId: String,
    private val currentUserId: String,
) : ViewModel() {

    private val _uiState = MutableStateFlow<ChatThreadUiState>(ChatThreadUiState.Loading)
    val uiState: StateFlow<ChatThreadUiState> = _uiState.asStateFlow()

    private val effects = Channel<ChatEffect>(Channel.BUFFERED)
    val effect: Flow<ChatEffect> = effects.receiveAsFlow()

    private var disconnect: RealtimeDisconnect? = null

    init {
        // Mirror the repository message store into content state (optimistic + realtime).
        viewModelScope.launch {
            repository.messages(channelId).collect { entries ->
                if (_uiState.value !is ChatThreadUiState.Error || entries.isNotEmpty()) {
                    _uiState.value = ChatThreadUiState.Content(entries)
                }
            }
        }
        disconnect = repository.connectRealtime(channelId)
    }

    fun load() {
        viewModelScope.launch {
            if (_uiState.value !is ChatThreadUiState.Content) _uiState.value = ChatThreadUiState.Loading
            try {
                repository.loadMessages(channelId)
            } catch (e: AppErrorException) {
                _uiState.value = ChatThreadUiState.Error(e.appError)
            } catch (e: Throwable) {
                _uiState.value = ChatThreadUiState.Error(AppError.Server("UNKNOWN", null))
            }
        }
    }

    fun send(body: String) {
        if (body.isBlank()) return
        viewModelScope.launch {
            when (val result = repository.sendMessage(channelId, currentUserId, body)) {
                is ChatSendResult.Ok -> Unit // promoted; list already updated
                is ChatSendResult.Failure -> effects.send(ChatEffect.SendFailed(result.localId, result.error))
            }
        }
    }

    override fun onCleared() {
        disconnect?.disconnect()
        disconnect = null
    }
}
