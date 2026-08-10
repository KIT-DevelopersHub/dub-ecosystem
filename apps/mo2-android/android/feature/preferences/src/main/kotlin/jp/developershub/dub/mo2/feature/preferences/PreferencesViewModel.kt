// PreferencesViewModel (S8) — notification preferences. MVI/UDF over MobileBffClient:
// loading / content / error. Toggling a channel for a notification type is applied
// optimistically and persisted via PATCH /preferences; a failed save rolls the local
// toggle back (a preference is not versioned, so revert-on-failure is sufficient).
package jp.developershub.dub.mo2.feature.preferences

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import jp.developershub.dub.mo2.core.model.NotificationChannel
import jp.developershub.dub.mo2.core.model.PreferenceEntry
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import jp.developershub.dub.mo2.core.network.MobileBffClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface PreferencesUiState {
    data object Loading : PreferencesUiState
    data class Content(val prefs: List<PreferenceEntry>) : PreferencesUiState
    data class Error(val error: AppError) : PreferencesUiState
}

class PreferencesViewModel(
    private val client: MobileBffClient,
) : ViewModel() {

    private val _uiState = MutableStateFlow<PreferencesUiState>(PreferencesUiState.Loading)
    val uiState: StateFlow<PreferencesUiState> = _uiState.asStateFlow()

    private var prefs: List<PreferenceEntry> = emptyList()

    fun load() {
        viewModelScope.launch {
            if (_uiState.value !is PreferencesUiState.Content) _uiState.value = PreferencesUiState.Loading
            try {
                prefs = client.getPreferences()
                _uiState.value = PreferencesUiState.Content(prefs)
            } catch (e: AppErrorException) {
                _uiState.value = PreferencesUiState.Error(e.appError)
            } catch (e: Throwable) {
                _uiState.value = PreferencesUiState.Error(AppError.Server("UNKNOWN", null))
            }
        }
    }

    /** Optimistically add/remove a channel for a notification type, then persist. */
    fun toggleChannel(type: String, channel: NotificationChannel) {
        val previous = prefs
        prefs = prefs.map { entry ->
            if (entry.type != type) {
                entry
            } else {
                val channels = if (entry.channels.contains(channel)) {
                    entry.channels.filter { it != channel }
                } else {
                    entry.channels + channel
                }
                entry.copy(channels = channels)
            }
        }
        _uiState.value = PreferencesUiState.Content(prefs)
        viewModelScope.launch {
            try {
                prefs = client.updatePreferences(prefs)
                _uiState.value = PreferencesUiState.Content(prefs)
            } catch (_: Throwable) {
                prefs = previous // revert the local toggle
                _uiState.value = PreferencesUiState.Content(prefs)
            }
        }
    }
}
