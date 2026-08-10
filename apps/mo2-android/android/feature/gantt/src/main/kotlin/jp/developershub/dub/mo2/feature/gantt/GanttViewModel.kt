// GanttViewModel (S11) — the MVI/UDF state machine for the per-event gantt view,
// modeled 1:1 on HomeViewModel / gantt.ts (§2-2 MviViewModel<S,E>; §7 unit target:
// initial load / refresh / error / empty / view-pref edit). The chart (rows + FS
// deps) is a read model over task/event owned by gantt-service; zoom + collapsed
// rows are a per-user view pref applied optimistically and best-effort persisted —
// a failed pref save never blanks the chart (§6 stale-while-error).
package jp.developershub.dub.mo2.feature.gantt

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import jp.developershub.dub.mo2.core.model.GanttChartDTO
import jp.developershub.dub.mo2.core.model.GanttZoom
import jp.developershub.dub.mo2.core.model.PutGanttViewRequest
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import jp.developershub.dub.mo2.core.network.MobileBffClient
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Client-local view prefs (mirror of gantt.GanttViewState minus eventId). */
data class GanttView(
    val zoom: GanttZoom = GanttZoom.WEEK,
    val collapsedTaskIds: List<String> = emptyList(),
)

sealed interface GanttUiState {
    data object Loading : GanttUiState
    data class Content(
        val chart: GanttChartDTO,
        val view: GanttView,
        val isEmpty: Boolean,
    ) : GanttUiState
    /** stale-while-error banner: cached is the last-good chart, if any. */
    data class Error(val error: AppError, val cached: GanttChartDTO?) : GanttUiState
}

sealed interface GanttEvent {
    data object Load : GanttEvent
    data object Refresh : GanttEvent
    data class SetZoom(val zoom: GanttZoom) : GanttEvent
    data class ToggleCollapse(val taskId: String) : GanttEvent
}

class GanttViewModel(
    private val client: MobileBffClient,
    private val eventId: String,
) : ViewModel() {

    private val _uiState = MutableStateFlow<GanttUiState>(GanttUiState.Loading)
    val uiState: StateFlow<GanttUiState> = _uiState.asStateFlow()

    private var lastGood: GanttChartDTO? = null
    private var view: GanttView = GanttView()

    fun onEvent(event: GanttEvent) {
        when (event) {
            GanttEvent.Load, GanttEvent.Refresh -> fetch()
            is GanttEvent.SetZoom -> applyView(view.copy(zoom = event.zoom))
            is GanttEvent.ToggleCollapse ->
                applyView(view.copy(collapsedTaskIds = view.collapsedTaskIds.toggle(event.taskId)))
        }
    }

    private fun fetch() {
        viewModelScope.launch {
            if (_uiState.value !is GanttUiState.Content) _uiState.value = GanttUiState.Loading
            try {
                // chart + persisted view prefs load together; a missing/failed view
                // pref must not blank the chart, so the view read degrades to null.
                val (chart, loadedView) = coroutineScope {
                    val viewDeferred = async {
                        try {
                            client.getGanttView(eventId)
                        } catch (_: Throwable) {
                            null
                        }
                    }
                    val chartValue = client.getGantt(eventId)
                    chartValue to viewDeferred.await()
                }
                lastGood = chart
                if (loadedView != null) {
                    view = GanttView(loadedView.zoom, loadedView.collapsedTaskIds.toList())
                }
                _uiState.value = GanttUiState.Content(chart, view, isEmpty = chart.rows.isEmpty())
            } catch (e: AppErrorException) {
                _uiState.value = GanttUiState.Error(e.appError, lastGood)
            } catch (e: Throwable) {
                _uiState.value = GanttUiState.Error(AppError.Server("UNKNOWN", null), lastGood)
            }
        }
    }

    /** Optimistically apply a view pref (zoom/collapse) and best-effort persist it. */
    private fun applyView(next: GanttView) {
        view = next
        (_uiState.value as? GanttUiState.Content)?.let { _uiState.value = it.copy(view = next) }
        viewModelScope.launch {
            try {
                // View prefs are non-critical: a failed save is swallowed (local view stays).
                client.saveGanttView(eventId, PutGanttViewRequest(next.zoom, next.collapsedTaskIds))
            } catch (_: Throwable) {
                // keep the optimistic local view; prefs re-sync on next successful load.
            }
        }
    }
}

private fun List<String>.toggle(id: String): List<String> =
    if (contains(id)) filter { it != id } else this + id
