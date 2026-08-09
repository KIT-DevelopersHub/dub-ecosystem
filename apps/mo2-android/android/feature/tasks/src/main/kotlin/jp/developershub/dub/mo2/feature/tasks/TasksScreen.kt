// TasksScreen (S5) + TaskDetailScreen (S6) — Compose UI over TasksViewModel.
// The list reflects the repository cache (optimistic apply is visible instantly);
// the detail offers only legal status transitions (TASK_STATUS_TRANSITIONS) and
// reports 409 conflicts via a snackbar (theme3 D4). Stateless composables take
// the resolved state so they stay preview- and screenshot-friendly.
package jp.developershub.dub.mo2.feature.tasks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.developershub.dub.mo2.core.model.TASK_STATUS_TRANSITIONS
import jp.developershub.dub.mo2.core.model.TaskStatus
import jp.developershub.dub.mo2.core.model.TaskSummary

@Composable
fun TasksScreen(
    state: TasksUiState,
    onTaskClick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (state) {
        is TasksUiState.Loading -> Centered(modifier) { CircularProgressIndicator() }
        is TasksUiState.Error -> Centered(modifier) { Text("Couldn't load tasks: ${state.error}") }
        is TasksUiState.Content ->
            if (state.isEmpty) {
                Centered(modifier) { Text("No tasks assigned to you.") }
            } else {
                LazyColumn(modifier = modifier.fillMaxSize()) {
                    items(state.tasks, key = { it.id }) { task ->
                        TaskRow(task, onClick = { onTaskClick(task.id) })
                    }
                }
            }
    }
}

@Composable
private fun TaskRow(task: TaskSummary, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .clickable(onClick = onClick),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text(task.title)
            Text(task.status.label(), Modifier.padding(top = 4.dp))
        }
    }
}

/**
 * Task detail (S6). Renders the current status and the legal next transitions;
 * tapping one triggers the optimistic PATCH via [onChangeStatus].
 */
@Composable
fun TaskDetailScreen(
    title: String,
    status: TaskStatus,
    version: Int,
    onChangeStatus: (TaskStatus, Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxSize().padding(16.dp)) {
        Text(title)
        Text("Status: ${status.label()}", Modifier.padding(top = 8.dp))
        Text("Move to:", Modifier.padding(top = 16.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TASK_STATUS_TRANSITIONS[status].orEmpty().forEach { next ->
                FilterChip(
                    selected = false,
                    onClick = { onChangeStatus(next, version) },
                    label = { Text(next.label()) },
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

private fun TaskStatus.label(): String = when (this) {
    TaskStatus.TODO -> "To do"
    TaskStatus.IN_PROGRESS -> "In progress"
    TaskStatus.BLOCKED -> "Blocked"
    TaskStatus.DONE -> "Done"
    TaskStatus.CANCELLED -> "Cancelled"
}
