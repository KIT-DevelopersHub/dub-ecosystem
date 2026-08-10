// EventsScreen (S3) + EventDetailScreen (S4) — Compose UI over the events
// ViewModels. The list shows each event's title + phase; the detail shows the
// summary and the effective capability keys. On list error the last-good list is
// kept behind a banner (stale-while-error, §6). Stateless composables take the
// resolved state so they stay preview/screenshot friendly.
package jp.developershub.dub.mo2.feature.events

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.developershub.dub.mo2.core.model.EventSummary

@Composable
fun EventsScreen(
    state: EventsUiState,
    onEventClick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (state) {
        is EventsUiState.Loading -> Centered(modifier) { CircularProgressIndicator() }
        is EventsUiState.Content -> EventsList(state.events, state.isEmpty, banner = null, onEventClick, modifier)
        is EventsUiState.Error ->
            if (state.cached != null) {
                EventsList(state.cached, state.cached.isEmpty(), "Offline — showing last update", onEventClick, modifier)
            } else {
                Centered(modifier) { Text("Couldn't load events: ${state.error}") }
            }
    }
}

@Composable
private fun EventsList(
    events: List<EventSummary>,
    isEmpty: Boolean,
    banner: String?,
    onEventClick: (String) -> Unit,
    modifier: Modifier,
) {
    LazyColumn(modifier.fillMaxSize()) {
        if (banner != null) {
            item {
                Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                    Text(banner, Modifier.padding(12.dp))
                }
            }
        }
        if (isEmpty) {
            item { Centered(Modifier.fillMaxWidth().padding(24.dp)) { Text("No events yet.") } }
        } else {
            items(events, key = { it.id }) { ev -> EventRow(ev) { onEventClick(ev.id) } }
        }
    }
}

@Composable
private fun EventRow(event: EventSummary, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .clickable(onClick = onClick),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(event.title)
            Text(event.phase.name.lowercase(), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

@Composable
fun EventDetailScreen(state: EventDetailUiState, modifier: Modifier = Modifier) {
    when (state) {
        is EventDetailUiState.Loading -> Centered(modifier) { CircularProgressIndicator() }
        is EventDetailUiState.Error -> Centered(modifier) { Text("Couldn't load event: ${state.error}") }
        is EventDetailUiState.Content -> Column(modifier.fillMaxSize().padding(16.dp)) {
            Text(state.overview.event.title, style = MaterialTheme.typography.titleLarge)
            Text("Phase: ${state.overview.event.phase.name.lowercase()}", Modifier.padding(top = 8.dp))
            Text("Your capabilities", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 16.dp))
            state.overview.capabilities.forEach { Text("• $it", Modifier.padding(vertical = 2.dp)) }
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
