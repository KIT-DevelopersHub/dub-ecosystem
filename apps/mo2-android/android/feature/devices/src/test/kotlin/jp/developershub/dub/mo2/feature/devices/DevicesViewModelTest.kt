// DevicesViewModel unit tests (§7) — content / empty / error, optimistic revoke,
// and rollback + effect on a failed revoke.
package jp.developershub.dub.mo2.feature.devices

import app.cash.turbine.test
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class DevicesViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun `load yields content`() = runTest {
        val vm = DevicesViewModel(FakeMobileBffClient(devices = listOf(device("d1"), device("d2"))))
        vm.load()
        val state = vm.uiState.value
        assertTrue(state is DevicesUiState.Content)
        assertEquals(2, (state as DevicesUiState.Content).devices.size)
    }

    @Test
    fun `empty list yields empty content`() = runTest {
        val vm = DevicesViewModel(FakeMobileBffClient(devices = emptyList()))
        vm.load()
        assertTrue((vm.uiState.value as DevicesUiState.Content).isEmpty)
    }

    @Test
    fun `load error surfaces as error state`() = runTest {
        val vm = DevicesViewModel(FakeMobileBffClient(onListDevices = {
            throw AppErrorException(AppError.Server("INTERNAL", null))
        }))
        vm.load()
        assertTrue(vm.uiState.value is DevicesUiState.Error)
    }

    @Test
    fun `revoke optimistically removes the device and calls the server`() = runTest {
        val fake = FakeMobileBffClient(devices = listOf(device("d1"), device("d2")))
        val vm = DevicesViewModel(fake)
        vm.load()
        vm.revoke("d1")
        val state = vm.uiState.value as DevicesUiState.Content
        assertEquals(listOf("d2"), state.devices.map { it.id })
        assertEquals(1, fake.deleteCalls)
    }

    @Test
    fun `a failed revoke rolls back and emits an effect`() = runTest {
        val fake = FakeMobileBffClient(
            devices = listOf(device("d1"), device("d2")),
            onDeleteDevice = { throw AppErrorException(AppError.Server("INTERNAL", null)) },
        )
        val vm = DevicesViewModel(fake)
        vm.load()

        vm.effect.test {
            vm.revoke("d1")
            val effect = awaitItem()
            assertTrue(effect is DevicesEffect.RevokeFailed)
            assertEquals("d1", (effect as DevicesEffect.RevokeFailed).deviceId)
            cancelAndIgnoreRemainingEvents()
        }
        // rolled back: both devices present again
        assertEquals(listOf("d1", "d2"), (vm.uiState.value as DevicesUiState.Content).devices.map { it.id })
    }
}
