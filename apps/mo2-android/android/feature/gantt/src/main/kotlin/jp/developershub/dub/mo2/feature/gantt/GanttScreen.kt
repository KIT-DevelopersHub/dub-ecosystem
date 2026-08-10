// GanttScreen (S11) — Compose UI over GanttViewModel. Renders the chart read model
// (one row per task with its progress + assignee) and the FS dependency count, with
// a zoom selector and per-row collapse toggle wired to the optimistic view prefs.
// On error it shows a banner while keeping the last-good chart visible
// (stale-while-error, §6). Stateless: takes the resolved GanttUiState so it is
// preview/screenshot friendly.
package jp.developershub.dub.mo2.feature.gantt

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
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.developershub.dub.mo2.core.model.GanttChartDTO
import jp.developershub.dub.mo2.core.model.GanttRow
import jp.developershub.dub.mo2.core.model.GanttZoom

@Composable
fun GanttScreen(
    state: GanttUiState,
    onEvent: (GanttEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (state) {
        is GanttUiState.Loading -> Centered(modifier) { CircularProgressIndicator() }
        is GanttUiState.Content ->
            GanttContent(state.chart, state.view, state.isEmpty, banner = null, onEvent, modifier)
        is GanttUiState.Error ->
            if (state.cached != null) {
                GanttContent(
                    state.cached,
                    GanttView(),
                    isEmpty = state.cached.rows.isEmpty(),
                    banner = "Offline — showing last update",
                    onEvent = onEvent,
                    modifier = modifier,
                )
            } else {
                Centered(modifier) { Text("Couldn't load gantt: ${state.error}") }
            }
    }
}

@Composable
private fun GanttContent(
    chart: GanttChartDTO,
    view: GanttView,
    isEmpty: Boolean,
    banner: String?,
    onEvent: (GanttEvent) -> Unit,
    modifier: Modifier,
) {
    LazyColumn(modifier = modifier.fillMaxSize().padding(16.dp)) {
        if (banner != null) {
            item {
                Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                    Text(banner, Modifier.padding(12.dp))
                }
            }
        }
        item { ZoomSelector(view.zoom, onEvent) }
        if (isEmpty) {
            item { Text("No scheduled tasks in this event.", Modifier.padding(vertical = 12.dp)) }
        } else {
            items(chart.rows, key = { it.taskId }) { row ->
                GanttRowItem(
                    row = row,
                    collapsed = view.collapsedTaskIds.contains(row.taskId),
                    onToggle = { onEvent(GanttEvent.ToggleCollapse(row.taskId)) },
                )
            }
            item {
                Text(
                    "${chart.dependencies.size} dependency link(s)",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        }
    }
}

@Composable
private fun ZoomSelector(zoom: GanttZoom, onEvent: (GanttEvent) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 8.dp)) {
        GanttZoom.entries.forEach { z ->
            FilterChip(
                selected = z == zoom,
                onClick = { onEvent(GanttEvent.SetZoom(z)) },
                label = { Text(z.label()) },
            )
        }
    }
}

@Composable
private fun GanttRowItem(row: GanttRow, collapsed: Boolean, onToggle: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp).clickable(onClick = onToggle)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (collapsed) "+" else "-", Modifier.padding(end = 4.dp))
            Text(row.title)
        }
        if (!collapsed) {
            Text(
                "${row.progressPercent}%" + (row.assigneeId?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(start = 20.dp, top = 2.dp),
            )
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

private fun GanttZoom.label(): String = when (this) {
    GanttZoom.DAY -> "Day"
    GanttZoom.WEEK -> "Week"
    GanttZoom.MONTH -> "Month"
}
