// DevicesViewModel — registered push devices (settings > devices). MVI/UDF over
// MobileBffClient: loading / content / error. Revoking a device is applied
// optimistically (removed from the list) and rolled back on failure. A one-shot
// effect reports a failed revoke so the UI can surface a snackbar.
package jp.developershub.dub.mo2.feature.devices

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import jp.developershub.dub.mo2.core.model.DeviceDto
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

sealed interface DevicesUiState {
    data object Loading : DevicesUiState
    data class Content(val devices: List<DeviceDto>, val isEmpty: Boolean) : DevicesUiState
    data class Error(val error: AppError) : DevicesUiState
}

sealed interface DevicesEffect {
    data class RevokeFailed(val deviceId: String, val error: AppError) : DevicesEffect
}

class DevicesViewModel(
    private val client: MobileBffClient,
) : ViewModel() {

    private val _uiState = MutableStateFlow<DevicesUiState>(DevicesUiState.Loading)
    val uiState: StateFlow<DevicesUiState> = _uiState.asStateFlow()

    private val effects = Channel<DevicesEffect>(Channel.BUFFERED)
    val effect: Flow<DevicesEffect> = effects.receiveAsFlow()

    private var devices: List<DeviceDto> = emptyList()

    fun load() {
        viewModelScope.launch {
            if (_uiState.value !is DevicesUiState.Content) _uiState.value = DevicesUiState.Loading
            try {
                devices = client.listDevices()
                emitContent()
            } catch (e: AppErrorException) {
                _uiState.value = DevicesUiState.Error(e.appError)
            } catch (e: Throwable) {
                _uiState.value = DevicesUiState.Error(AppError.Server("UNKNOWN", null))
            }
        }
    }

    /** Optimistically revoke a device; rollback + report on failure. */
    fun revoke(deviceId: String) {
        val previous = devices
        devices = devices.filter { it.id != deviceId }
        emitContent()
        viewModelScope.launch {
            try {
                client.deleteDevice(deviceId)
            } catch (e: Throwable) {
                devices = previous
                emitContent()
                val error = (e as? AppErrorException)?.appError ?: AppError.Server("UNKNOWN", null)
                effects.send(DevicesEffect.RevokeFailed(deviceId, error))
            }
        }
    }

    private fun emitContent() {
        _uiState.value = DevicesUiState.Content(devices, isEmpty = devices.isEmpty())
    }
}
