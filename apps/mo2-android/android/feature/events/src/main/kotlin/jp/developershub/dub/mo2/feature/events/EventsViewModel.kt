// EventsViewModel (S3) — the events list, and EventDetailViewModel (S4) — the
// event overview (summary + effective capabilities). Both are MVI/UDF over
// MobileBffClient, mirroring HomeViewModel: loading / content / empty / error with
// stale-while-error (§6). The "Event > Action" hierarchy is absolute; MO2 consumes
// the summary + capability shapes only.
package jp.developershub.dub.mo2.feature.events

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import jp.developershub.dub.mo2.core.model.EventSummary
import jp.developershub.dub.mo2.core.model.MobileEventOverviewResponse
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import jp.developershub.dub.mo2.core.network.MobileBffClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

// ---- events list (S3) ----

sealed interface EventsUiState {
    data object Loading : EventsUiState
    data class Content(val events: List<EventSummary>, val isEmpty: Boolean) : EventsUiState
    data class Error(val error: AppError, val cached: List<EventSummary>?) : EventsUiState
}

class EventsViewModel(
    private val client: MobileBffClient,
) : ViewModel() {

    private val _uiState = MutableStateFlow<EventsUiState>(EventsUiState.Loading)
    val uiState: StateFlow<EventsUiState> = _uiState.asStateFlow()

    private var lastGood: List<EventSummary>? = null

    fun load() = fetch()
    fun refresh() = fetch()

    private fun fetch() {
        viewModelScope.launch {
            if (_uiState.value !is EventsUiState.Content) _uiState.value = EventsUiState.Loading
            try {
                val events = client.getEvents().items
                lastGood = events
                _uiState.value = EventsUiState.Content(events, isEmpty = events.isEmpty())
            } catch (e: AppErrorException) {
                _uiState.value = EventsUiState.Error(e.appError, lastGood)
            } catch (e: Throwable) {
                _uiState.value = EventsUiState.Error(AppError.Server("UNKNOWN", null), lastGood)
            }
        }
    }
}

// ---- event overview (S4) ----

sealed interface EventDetailUiState {
    data object Loading : EventDetailUiState
    data class Content(val overview: MobileEventOverviewResponse) : EventDetailUiState
    data class Error(val error: AppError) : EventDetailUiState
}

class EventDetailViewModel(
    private val client: MobileBffClient,
    private val eventId: String,
) : ViewModel() {

    private val _uiState = MutableStateFlow<EventDetailUiState>(EventDetailUiState.Loading)
    val uiState: StateFlow<EventDetailUiState> = _uiState.asStateFlow()

    fun load() {
        viewModelScope.launch {
            _uiState.value = EventDetailUiState.Loading
            try {
                _uiState.value = EventDetailUiState.Content(client.getEventOverview(eventId))
            } catch (e: AppErrorException) {
                _uiState.value = EventDetailUiState.Error(e.appError)
            } catch (e: Throwable) {
                _uiState.value = EventDetailUiState.Error(AppError.Server("UNKNOWN", null))
            }
        }
    }
}
