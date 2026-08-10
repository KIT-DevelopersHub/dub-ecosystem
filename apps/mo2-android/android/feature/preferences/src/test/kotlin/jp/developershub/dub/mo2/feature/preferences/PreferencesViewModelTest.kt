// PreferencesViewModel unit tests (§7) — content, error, optimistic toggle (add /
// remove a channel) persisted via PATCH, and rollback on a failed save.
package jp.developershub.dub.mo2.feature.preferences

import jp.developershub.dub.mo2.core.model.NotificationChannel
import jp.developershub.dub.mo2.core.model.PreferenceEntry
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class PreferencesViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private fun entry(type: String, vararg channels: NotificationChannel) =
        PreferenceEntry(type, channels.toList())

    @Test
    fun `load yields content`() = runTest {
        val fake = FakeMobileBffClient(prefs = listOf(entry("task.assigned", NotificationChannel.PUSH)))
        val vm = PreferencesViewModel(fake)
        vm.load()
        val state = vm.uiState.value
        assertTrue(state is PreferencesUiState.Content)
        assertEquals(1, (state as PreferencesUiState.Content).prefs.size)
    }

    @Test
    fun `load error surfaces as error state`() = runTest {
        val vm = PreferencesViewModel(FakeMobileBffClient(onGetPreferences = {
            throw AppErrorException(AppError.Server("INTERNAL", null))
        }))
        vm.load()
        assertTrue(vm.uiState.value is PreferencesUiState.Error)
    }

    @Test
    fun `toggle removes an enabled channel and persists`() = runTest {
        val fake = FakeMobileBffClient(prefs = listOf(entry("task.assigned", NotificationChannel.PUSH, NotificationChannel.EMAIL)))
        val vm = PreferencesViewModel(fake)
        vm.load()
        vm.toggleChannel("task.assigned", NotificationChannel.EMAIL)
        val prefs = (vm.uiState.value as PreferencesUiState.Content).prefs.single()
        assertFalse(prefs.channels.contains(NotificationChannel.EMAIL))
        assertTrue(prefs.channels.contains(NotificationChannel.PUSH))
        assertEquals(listOf(NotificationChannel.PUSH), fake.lastUpdate?.single()?.channels)
    }

    @Test
    fun `toggle adds a disabled channel`() = runTest {
        val fake = FakeMobileBffClient(prefs = listOf(entry("task.assigned", NotificationChannel.PUSH)))
        val vm = PreferencesViewModel(fake)
        vm.load()
        vm.toggleChannel("task.assigned", NotificationChannel.IN_APP)
        val prefs = (vm.uiState.value as PreferencesUiState.Content).prefs.single()
        assertTrue(prefs.channels.contains(NotificationChannel.IN_APP))
    }

    @Test
    fun `a failed save reverts the local toggle`() = runTest {
        val fake = FakeMobileBffClient(
            prefs = listOf(entry("task.assigned", NotificationChannel.PUSH)),
            onUpdatePreferences = { throw AppErrorException(AppError.Server("INTERNAL", null)) },
        )
        val vm = PreferencesViewModel(fake)
        vm.load()
        vm.toggleChannel("task.assigned", NotificationChannel.EMAIL)
        val prefs = (vm.uiState.value as PreferencesUiState.Content).prefs.single()
        assertFalse(prefs.channels.contains(NotificationChannel.EMAIL)) // reverted
    }
}
