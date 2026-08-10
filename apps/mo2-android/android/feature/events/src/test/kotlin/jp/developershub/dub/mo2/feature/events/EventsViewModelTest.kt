// EventsViewModel / EventDetailViewModel unit tests (§7) — list content / empty /
// error / stale-while-error, and overview content + error.
package jp.developershub.dub.mo2.feature.events

import jp.developershub.dub.mo2.core.model.EventPhase
import jp.developershub.dub.mo2.core.model.EventSummary
import jp.developershub.dub.mo2.core.model.MobileEventOverviewResponse
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class EventsViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private fun event(id: String) = EventSummary(id, "Event $id", EventPhase.OPEN, null)

    @Test
    fun `load yields content with the server list`() = runTest {
        val vm = EventsViewModel(FakeMobileBffClient(onGetEvents = { listOf(event("a"), event("b")) }))
        vm.load()
        val state = vm.uiState.value
        assertTrue(state is EventsUiState.Content)
        assertEquals(listOf("a", "b"), (state as EventsUiState.Content).events.map { it.id })
        assertTrue(!state.isEmpty)
    }

    @Test
    fun `empty list yields empty content`() = runTest {
        val vm = EventsViewModel(FakeMobileBffClient(onGetEvents = { emptyList() }))
        vm.load()
        assertTrue((vm.uiState.value as EventsUiState.Content).isEmpty)
    }

    @Test
    fun `error with no prior data has null cache`() = runTest {
        val vm = EventsViewModel(FakeMobileBffClient(onGetEvents = {
            throw AppErrorException(AppError.Network(retryable = true))
        }))
        vm.load()
        val state = vm.uiState.value
        assertTrue(state is EventsUiState.Error)
        assertNull((state as EventsUiState.Error).cached)
    }

    @Test
    fun `refresh error keeps last-good list behind the banner`() = runTest {
        var fail = false
        val good = listOf(event("a"))
        val vm = EventsViewModel(FakeMobileBffClient(onGetEvents = {
            if (fail) throw AppErrorException(AppError.Network(retryable = true)) else good
        }))
        vm.load()
        fail = true
        vm.refresh()
        val state = vm.uiState.value
        assertTrue(state is EventsUiState.Error)
        assertEquals(good, (state as EventsUiState.Error).cached)
    }

    @Test
    fun `overview load yields content with capabilities`() = runTest {
        val overview = MobileEventOverviewResponse(event("a"), listOf("event:read", "task:write"))
        val vm = EventDetailViewModel(FakeMobileBffClient(onGetOverview = { overview }), "a")
        vm.load()
        val state = vm.uiState.value
        assertTrue(state is EventDetailUiState.Content)
        assertEquals(listOf("event:read", "task:write"), (state as EventDetailUiState.Content).overview.capabilities)
    }

    @Test
    fun `overview error surfaces as error state`() = runTest {
        val vm = EventDetailViewModel(FakeMobileBffClient(onGetOverview = {
            throw AppErrorException(AppError.Forbidden("EVENT_FORBIDDEN"))
        }), "a")
        vm.load()
        assertTrue(vm.uiState.value is EventDetailUiState.Error)
    }
}
