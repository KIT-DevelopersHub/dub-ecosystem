// HomeScreen (S2) — Compose UI over HomeViewModel. Renders the home aggregate
// (upcoming events, my tasks, unread badge). On error it shows a banner while
// keeping the last-good content visible (stale-while-error, §6). Stateless: takes
// the resolved HomeUiState so it is preview/screenshot friendly.
package jp.developershub.dub.mo2.feature.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.developershub.dub.mo2.core.model.MobileHomeResponse

@Composable
fun HomeScreen(
    state: HomeUiState,
    modifier: Modifier = Modifier,
) {
    when (state) {
        is HomeUiState.Loading -> Centered(modifier) { CircularProgressIndicator() }
        is HomeUiState.Content -> HomeContent(state.home, banner = null, modifier)
        is HomeUiState.Error ->
            if (state.cached != null) {
                HomeContent(state.cached, banner = "Offline — showing last update", modifier)
            } else {
                Centered(modifier) { Text("Couldn't load home: ${state.error}") }
            }
    }
}

@Composable
private fun HomeContent(home: MobileHomeResponse, banner: String?, modifier: Modifier) {
    LazyColumn(modifier = modifier.fillMaxSize().padding(16.dp)) {
        if (banner != null) {
            item {
                Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                    Text(banner, Modifier.padding(12.dp))
                }
            }
        }
        item { Text("Unread: ${home.unreadCount}", Modifier.padding(vertical = 8.dp)) }
        item { Text("Upcoming events", style = MaterialTheme.typography.titleMedium) }
        items(home.upcomingEvents, key = { it.id }) { Text(it.title, Modifier.padding(vertical = 4.dp)) }
        item { Text("My tasks", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp)) }
        items(home.myTasks, key = { it.id }) { Text(it.title, Modifier.padding(vertical = 4.dp)) }
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
