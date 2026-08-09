// HomeViewModel unit tests (§7) — initial load, empty aggregate, error, and the
// stale-while-error path (keep last-good content behind the offline banner).
// Mirrors home-view-model.test.ts.
package jp.developershub.dub.mo2.feature.home

import jp.developershub.dub.mo2.core.model.EventSummary
import jp.developershub.dub.mo2.core.model.EventPhase
import jp.developershub.dub.mo2.core.model.MobileHomeResponse
import jp.developershub.dub.mo2.core.model.TaskStatus
import jp.developershub.dub.mo2.core.model.TaskSummary
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class HomeViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private fun home(events: Int = 0, tasks: Int = 0, unread: Int = 0) = MobileHomeResponse(
        upcomingEvents = (1..events).map { EventSummary("evt_$it", "Event $it", EventPhase.OPEN, null) },
        myTasks = (1..tasks).map { TaskSummary("t_$it", "Task $it", TaskStatus.TODO, null) },
        unreadCount = unread,
    )

    @Test
    fun `load yields content when data is present`() = runTest {
        val vm = HomeViewModel(FakeMobileBffClient(onGetHome = { home(events = 2, unread = 3) }))
        vm.onEvent(HomeEvent.Load)
        val state = vm.uiState.value
        assertTrue(state is HomeUiState.Content)
        assertTrue(!(state as HomeUiState.Content).isEmpty)
    }

    @Test
    fun `load yields empty content when aggregate is empty`() = runTest {
        val vm = HomeViewModel(FakeMobileBffClient(onGetHome = { home() }))
        vm.onEvent(HomeEvent.Load)
        val state = vm.uiState.value
        assertTrue(state is HomeUiState.Content && state.isEmpty)
    }

    @Test
    fun `error with no prior data has null cache`() = runTest {
        val vm = HomeViewModel(FakeMobileBffClient(onGetHome = {
            throw AppErrorException(AppError.Network(retryable = true))
        }))
        vm.onEvent(HomeEvent.Load)
        val state = vm.uiState.value
        assertTrue(state is HomeUiState.Error)
        assertNull((state as HomeUiState.Error).cached)
    }

    @Test
    fun `refresh error keeps last-good content behind the banner`() = runTest {
        var fail = false
        val good = home(events = 1)
        val vm = HomeViewModel(FakeMobileBffClient(onGetHome = {
            if (fail) throw AppErrorException(AppError.Network(retryable = true)) else good
        }))
        vm.onEvent(HomeEvent.Load) // success -> lastGood set
        fail = true
        vm.onEvent(HomeEvent.Refresh) // error -> cached retained

        val state = vm.uiState.value
        assertTrue(state is HomeUiState.Error)
        assertEquals(good, (state as HomeUiState.Error).cached)
    }
}
