// ChannelListScreen (S10) + ChatScreen (S10) — Compose UI over the chat ViewModels.
// The channel list flows from the repository; the thread shows each message with a
// delivery indicator (pending / failed) driven by the optimistic-send state. The
// composer posts through the ViewModel. Stateless composables take the resolved
// state so they stay preview/screenshot friendly.
package jp.developershub.dub.mo2.feature.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.developershub.dub.mo2.core.model.ChatChannel

@Composable
fun ChannelListScreen(
    state: ChannelListUiState,
    onChannelClick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (state) {
        is ChannelListUiState.Loading -> Centered(modifier) { CircularProgressIndicator() }
        is ChannelListUiState.Error -> Centered(modifier) { Text("Couldn't load channels: ${state.error}") }
        is ChannelListUiState.Content ->
            if (state.isEmpty) {
                Centered(modifier) { Text("No channels yet.") }
            } else {
                LazyColumn(modifier.fillMaxSize()) {
                    items(state.channels, key = { it.id }) { ch -> ChannelRow(ch) { onChannelClick(ch.id) } }
                }
            }
    }
}

@Composable
private fun ChannelRow(channel: ChatChannel, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .clickable(onClick = onClick),
    ) {
        Text("# ${channel.name}", Modifier.padding(16.dp))
    }
}

@Composable
fun ChatScreen(
    state: ChatThreadUiState,
    onSend: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxSize()) {
        when (state) {
            is ChatThreadUiState.Loading ->
                Centered(Modifier.weight(1f)) { CircularProgressIndicator() }
            is ChatThreadUiState.Error ->
                Centered(Modifier.weight(1f)) { Text("Couldn't load messages: ${state.error}") }
            is ChatThreadUiState.Content ->
                LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp)) {
                    items(state.entries, key = { it.localId ?: it.message.id }) { entry -> MessageRow(entry) }
                }
        }
        Composer(onSend)
    }
}

@Composable
private fun MessageRow(entry: ChatMessageEntry) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(entry.message.authorId, style = MaterialTheme.typography.labelSmall)
        Text(entry.message.body)
        val badge = when (entry.state) {
            ChatSendState.PENDING -> "Sending…"
            ChatSendState.FAILED -> "Failed — tap to retry"
            ChatSendState.SENT -> null
        }
        if (badge != null) {
            Text(
                badge,
                style = MaterialTheme.typography.labelSmall,
                color = if (entry.state == ChatSendState.FAILED) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }
    }
}

@Composable
private fun Composer(onSend: (String) -> Unit) {
    var draft by remember { mutableStateOf("") }
    Row(
        modifier = Modifier.fillMaxWidth().padding(8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            modifier = Modifier.weight(1f),
            placeholder = { Text("Message") },
        )
        Button(onClick = {
            val body = draft.trim()
            if (body.isNotEmpty()) {
                onSend(body)
                draft = ""
            }
        }) {
            Text("Send")
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
