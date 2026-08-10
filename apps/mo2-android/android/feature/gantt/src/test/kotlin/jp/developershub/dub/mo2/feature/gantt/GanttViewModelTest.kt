// GanttViewModel unit tests (§7) — initial load (chart + persisted view), empty
// chart + default view, view-pref read failure degrading gracefully, stale-while-
// error on refresh, optimistic setZoom / toggleCollapse persisted via PATCH, and a
// swallowed failed save. Mirrors gantt.test.ts.
package jp.developershub.dub.mo2.feature.gantt

import jp.developershub.dub.mo2.core.model.GanttChartDTO
import jp.developershub.dub.mo2.core.model.GanttDependencyLine
import jp.developershub.dub.mo2.core.model.GanttRow
import jp.developershub.dub.mo2.core.model.GanttViewState
import jp.developershub.dub.mo2.core.model.GanttZoom
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class GanttViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private val row = GanttRow(
        taskId = "tsk_1",
        title = "Design",
        startsAt = "2026-08-01T00:00:00Z",
        endsAt = "2026-08-05T00:00:00Z",
        progressPercent = 0,
        assigneeId = "usr_1",
    )

    private fun chart(rows: List<GanttRow> = emptyList()) =
        GanttChartDTO(eventId = "evt_1", rows = rows, dependencies = emptyList<GanttDependencyLine>())

    private fun view(zoom: GanttZoom = GanttZoom.WEEK, collapsed: List<String> = emptyList()) =
        GanttViewState(eventId = "evt_1", zoom = zoom, collapsedTaskIds = collapsed)

    @Test
    fun `load success applies chart and persisted view`() = runTest {
        val fake = FakeMobileBffClient(
            onGetGantt = { chart(listOf(row)) },
            onGetGanttView = { view(GanttZoom.MONTH, listOf("tsk_1")) },
        )
        val vm = GanttViewModel(fake, "evt_1")
        vm.onEvent(GanttEvent.Load)

        val state = vm.uiState.value
        assertTrue(state is GanttUiState.Content)
        state as GanttUiState.Content
        assertFalse(state.isEmpty)
        assertEquals(1, state.chart.rows.size)
        assertEquals(GanttZoom.MONTH, state.view.zoom)
        assertEquals(listOf("tsk_1"), state.view.collapsedTaskIds)
    }

    @Test
    fun `empty chart yields isEmpty content with default view`() = runTest {
        val fake = FakeMobileBffClient(onGetGantt = { chart() }, onGetGanttView = { view() })
        val vm = GanttViewModel(fake, "evt_1")
        vm.onEvent(GanttEvent.Load)

        val state = vm.uiState.value as GanttUiState.Content
        assertTrue(state.isEmpty)
        assertEquals(GanttZoom.WEEK, state.view.zoom)
    }

    @Test
    fun `view-pref read failure degrades gracefully - chart still loads`() = runTest {
        val fake = FakeMobileBffClient(
            onGetGantt = { chart(listOf(row)) },
            onGetGanttView = { throw AppErrorException(AppError.Server("INTERNAL", null)) },
        )
        val vm = GanttViewModel(fake, "evt_1")
        vm.onEvent(GanttEvent.Load)

        val state = vm.uiState.value
        assertTrue(state is GanttUiState.Content)
        assertEquals(GanttZoom.WEEK, (state as GanttUiState.Content).view.zoom) // default
    }

    @Test
    fun `chart load failure on refresh keeps last-good cache`() = runTest {
        var fail = false
        val fake = FakeMobileBffClient(
            onGetGantt = {
                if (fail) throw AppErrorException(AppError.Server("INTERNAL", null)) else chart(listOf(row))
            },
            onGetGanttView = { view() },
        )
        val vm = GanttViewModel(fake, "evt_1")
        vm.onEvent(GanttEvent.Load)
        fail = true
        vm.onEvent(GanttEvent.Refresh)

        val state = vm.uiState.value
        assertTrue(state is GanttUiState.Error)
        state as GanttUiState.Error
        assertTrue(state.error is AppError.Server)
        assertEquals(1, state.cached?.rows?.size)
    }

    @Test
    fun `setZoom optimistically updates view and PATCHes gantt view`() = runTest {
        val fake = FakeMobileBffClient(onGetGantt = { chart(listOf(row)) }, onGetGanttView = { view() })
        val vm = GanttViewModel(fake, "evt_1")
        vm.onEvent(GanttEvent.Load)
        vm.onEvent(GanttEvent.SetZoom(GanttZoom.DAY))

        assertEquals(GanttZoom.DAY, (vm.uiState.value as GanttUiState.Content).view.zoom)
        assertEquals(1, fake.saveCalls)
        assertEquals(GanttZoom.DAY, fake.lastSaved?.zoom)
    }

    @Test
    fun `toggleCollapse adds then removes a task id optimistically`() = runTest {
        val fake = FakeMobileBffClient(onGetGantt = { chart(listOf(row)) }, onGetGanttView = { view() })
        val vm = GanttViewModel(fake, "evt_1")
        vm.onEvent(GanttEvent.Load)

        vm.onEvent(GanttEvent.ToggleCollapse("tsk_1"))
        assertEquals(listOf("tsk_1"), (vm.uiState.value as GanttUiState.Content).view.collapsedTaskIds)
        vm.onEvent(GanttEvent.ToggleCollapse("tsk_1"))
        assertEquals(emptyList<String>(), (vm.uiState.value as GanttUiState.Content).view.collapsedTaskIds)
    }

    @Test
    fun `a failed view-pref save is swallowed and local view stays`() = runTest {
        val fake = FakeMobileBffClient(
            onGetGantt = { chart(listOf(row)) },
            onGetGanttView = { view() },
            onSaveGanttView = { _, _ -> throw AppErrorException(AppError.Server("INTERNAL", null)) },
        )
        val vm = GanttViewModel(fake, "evt_1")
        vm.onEvent(GanttEvent.Load)
        vm.onEvent(GanttEvent.SetZoom(GanttZoom.DAY))

        assertEquals(GanttZoom.DAY, (vm.uiState.value as GanttUiState.Content).view.zoom)
    }

    @Test
    fun `error with no prior data has null cache`() = runTest {
        val fake = FakeMobileBffClient(
            onGetGantt = { throw AppErrorException(AppError.Network(retryable = true)) },
            onGetGanttView = { view() },
        )
        val vm = GanttViewModel(fake, "evt_1")
        vm.onEvent(GanttEvent.Load)

        val state = vm.uiState.value
        assertTrue(state is GanttUiState.Error)
        assertNull((state as GanttUiState.Error).cached)
    }
}
