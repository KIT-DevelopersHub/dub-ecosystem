// InboxScreen (S7) — Compose UI over InboxViewModel. Lists notifications with an
// unread indicator; tapping a row marks it read (optimistic), and a "Mark all read"
// action clears the unread badge. On error the last-good list is kept behind a
// banner (stale-while-error, §6). Stateless: takes the resolved state.
package jp.developershub.dub.mo2.feature.inbox

import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.developershub.dub.mo2.core.model.InboxItem

@Composable
fun InboxScreen(
    state: InboxUiState,
    onMarkRead: (String) -> Unit,
    onMarkAllRead: () -> Unit,
    modifier: Modifier = Modifier,
) {
    when (state) {
        is InboxUiState.Loading -> Centered(modifier) { CircularProgressIndicator() }
        is InboxUiState.Content ->
            InboxList(state.items, state.unreadCount, state.isEmpty, banner = null, onMarkRead, onMarkAllRead, modifier)
        is InboxUiState.Error ->
            if (state.cached != null) {
                InboxList(
                    state.cached,
                    state.cached.count { it.readAt == null },
                    state.cached.isEmpty(),
                    "Offline — showing last update",
                    onMarkRead,
                    onMarkAllRead,
                    modifier,
                )
            } else {
                Centered(modifier) { Text("Couldn't load inbox: ${state.error}") }
            }
    }
}

@Composable
private fun InboxList(
    items: List<InboxItem>,
    unreadCount: Int,
    isEmpty: Boolean,
    banner: String?,
    onMarkRead: (String) -> Unit,
    onMarkAllRead: () -> Unit,
    modifier: Modifier,
) {
    Column(modifier.fillMaxSize()) {
        if (banner != null) {
            Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                Text(banner, Modifier.padding(12.dp))
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Unread: $unreadCount", style = MaterialTheme.typography.titleMedium)
            if (unreadCount > 0) TextButton(onClick = onMarkAllRead) { Text("Mark all read") }
        }
        if (isEmpty) {
            Centered(Modifier.fillMaxWidth().padding(24.dp)) { Text("No notifications.") }
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(items, key = { it.id }) { item -> InboxRow(item) { onMarkRead(item.id) } }
            }
        }
    }
}

@Composable
private fun InboxRow(item: InboxItem, onClick: () -> Unit) {
    val unread = item.readAt == null
    Column(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(16.dp),
    ) {
        Text(
            item.title,
            fontWeight = if (unread) FontWeight.Bold else FontWeight.Normal,
        )
        Text(item.body, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 2.dp))
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
