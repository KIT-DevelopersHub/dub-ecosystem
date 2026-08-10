// PreferencesScreen (S8) — Compose UI over PreferencesViewModel. One section per
// notification type; each channel is a toggle that drives the optimistic
// toggleChannel. Stateless: takes the resolved state so it stays preview friendly.
package jp.developershub.dub.mo2.feature.preferences

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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.developershub.dub.mo2.core.model.NotificationChannel
import jp.developershub.dub.mo2.core.model.PreferenceEntry

@Composable
fun PreferencesScreen(
    state: PreferencesUiState,
    onToggle: (String, NotificationChannel) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (state) {
        is PreferencesUiState.Loading -> Centered(modifier) { CircularProgressIndicator() }
        is PreferencesUiState.Error -> Centered(modifier) { Text("Couldn't load preferences: ${state.error}") }
        is PreferencesUiState.Content ->
            LazyColumn(modifier.fillMaxSize().padding(16.dp)) {
                items(state.prefs, key = { it.type }) { entry -> PrefSection(entry, onToggle) }
            }
    }
}

@Composable
private fun PrefSection(entry: PreferenceEntry, onToggle: (String, NotificationChannel) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(entry.type, style = MaterialTheme.typography.titleMedium)
        NotificationChannel.entries.forEach { channel ->
            Row(
                Modifier.fillMaxWidth().padding(vertical = 4.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(channel.name.lowercase())
                Switch(
                    checked = entry.channels.contains(channel),
                    onCheckedChange = { onToggle(entry.type, channel) },
                )
            }
        }
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
