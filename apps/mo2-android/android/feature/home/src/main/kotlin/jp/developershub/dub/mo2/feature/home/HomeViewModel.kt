// HomeViewModel (S2) — the MVI/UDF reference (§2-2 MviViewModel<S,E>; §7 unit
// target: initial load / refresh / error / empty / cached-on-error). 1:1 port of
// home-view-model.ts, adapted to a StateFlow<HomeUiState>. On error the last-good
// aggregate is kept behind the banner (stale-while-error, §6 offline view).
package jp.developershub.dub.mo2.feature.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import jp.developershub.dub.mo2.core.model.MobileHomeResponse
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import jp.developershub.dub.mo2.core.network.MobileBffClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface HomeUiState {
    data object Loading : HomeUiState
    data class Content(val home: MobileHomeResponse, val isEmpty: Boolean) : HomeUiState
    /** stale-while-error banner: cached is the last good aggregate, if any. */
    data class Error(val error: AppError, val cached: MobileHomeResponse?) : HomeUiState
}

sealed interface HomeEvent {
    data object Load : HomeEvent
    data object Refresh : HomeEvent
}

class HomeViewModel(
    private val client: MobileBffClient,
) : ViewModel() {

    private val _uiState = MutableStateFlow<HomeUiState>(HomeUiState.Loading)
    val uiState: StateFlow<HomeUiState> = _uiState.asStateFlow()

    private var lastGood: MobileHomeResponse? = null

    fun onEvent(event: HomeEvent) {
        when (event) {
            HomeEvent.Load, HomeEvent.Refresh -> fetch()
        }
    }

    private fun fetch() {
        viewModelScope.launch {
            if (_uiState.value !is HomeUiState.Content) _uiState.value = HomeUiState.Loading
            try {
                val home = client.getHome()
                lastGood = home
                _uiState.value = HomeUiState.Content(home, isEmpty = home.isEmpty())
            } catch (e: AppErrorException) {
                _uiState.value = HomeUiState.Error(e.appError, lastGood)
            } catch (e: Throwable) {
                _uiState.value = HomeUiState.Error(AppError.Server("UNKNOWN", null), lastGood)
            }
        }
    }
}

private fun MobileHomeResponse.isEmpty(): Boolean =
    upcomingEvents.isEmpty() && myTasks.isEmpty() && unreadCount == 0
