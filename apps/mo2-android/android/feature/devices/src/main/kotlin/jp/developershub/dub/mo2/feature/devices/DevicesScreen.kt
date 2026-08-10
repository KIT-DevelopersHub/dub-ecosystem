// DevicesScreen — Compose UI over DevicesViewModel. Lists registered push devices
// with a revoke action per row (optimistic). Stateless: takes the resolved state.
package jp.developershub.dub.mo2.feature.devices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.developershub.dub.mo2.core.model.DeviceDto

@Composable
fun DevicesScreen(
    state: DevicesUiState,
    onRevoke: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (state) {
        is DevicesUiState.Loading -> Centered(modifier) { CircularProgressIndicator() }
        is DevicesUiState.Error -> Centered(modifier) { Text("Couldn't load devices: ${state.error}") }
        is DevicesUiState.Content ->
            if (state.isEmpty) {
                Centered(modifier) { Text("No registered devices.") }
            } else {
                LazyColumn(modifier.fillMaxSize().padding(horizontal = 12.dp)) {
                    items(state.devices, key = { it.id }) { device -> DeviceRow(device) { onRevoke(device.id) } }
                }
            }
    }
}

@Composable
private fun DeviceRow(device: DeviceDto, onRevoke: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column {
            Text(device.platform.name.lowercase())
            Text(device.registeredAt, style = MaterialTheme.typography.bodySmall)
        }
        TextButton(onClick = onRevoke) { Text("Revoke") }
    }
}

@Composable
private fun Centered(modifier: Modifier, content: @Composable () -> Unit) {
    Column(
        modifier = modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) { content() }
}
