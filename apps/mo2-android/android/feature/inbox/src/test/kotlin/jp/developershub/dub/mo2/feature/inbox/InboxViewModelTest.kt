// InboxViewModel unit tests (§7) — content + unread count, empty, error, optimistic
// mark-read (with rollback on failure) and mark-all-read.
package jp.developershub.dub.mo2.feature.inbox

import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class InboxViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private fun vm(fake: FakeMobileBffClient) = InboxViewModel(fake, now = { "2026-08-09T12:00:00Z" })

    @Test
    fun `load yields content with unread count`() = runTest {
        val fake = FakeMobileBffClient(inboxPage = listOf(inboxItem("a"), inboxItem("b", read = true)))
        val vm = vm(fake)
        vm.load()
        val state = vm.uiState.value
        assertTrue(state is InboxUiState.Content)
        assertEquals(1, (state as InboxUiState.Content).unreadCount)
        assertEquals(2, state.items.size)
    }

    @Test
    fun `empty inbox yields empty content`() = runTest {
        val vm = vm(FakeMobileBffClient(inboxPage = emptyList()))
        vm.load()
        assertTrue((vm.uiState.value as InboxUiState.Content).isEmpty)
    }

    @Test
    fun `error with no prior data has null cache`() = runTest {
        val vm = vm(FakeMobileBffClient(onGetInbox = {
            throw AppErrorException(AppError.Network(retryable = true))
        }))
        vm.load()
        assertNull((vm.uiState.value as InboxUiState.Error).cached)
    }

    @Test
    fun `markRead optimistically clears unread and calls the server`() = runTest {
        val fake = FakeMobileBffClient(inboxPage = listOf(inboxItem("a"), inboxItem("b")))
        val vm = vm(fake)
        vm.load()
        vm.markRead("a")
        val state = vm.uiState.value as InboxUiState.Content
        assertEquals(1, state.unreadCount)
        assertEquals(1, fake.markReadCalls)
    }

    @Test
    fun `markRead reverts the local flag when the server call fails`() = runTest {
        val fake = FakeMobileBffClient(
            inboxPage = listOf(inboxItem("a"), inboxItem("b")),
            onMarkRead = { throw AppErrorException(AppError.Server("INTERNAL", null)) },
        )
        val vm = vm(fake)
        vm.load()
        vm.markRead("a")
        // reverted: both still unread
        assertEquals(2, (vm.uiState.value as InboxUiState.Content).unreadCount)
    }

    @Test
    fun `markAllRead clears every unread item`() = runTest {
        val fake = FakeMobileBffClient(inboxPage = listOf(inboxItem("a"), inboxItem("b"), inboxItem("c", read = true)))
        val vm = vm(fake)
        vm.load()
        vm.markAllRead()
        val state = vm.uiState.value as InboxUiState.Content
        assertEquals(0, state.unreadCount)
        assertEquals(1, fake.markAllCalls)
    }
}
