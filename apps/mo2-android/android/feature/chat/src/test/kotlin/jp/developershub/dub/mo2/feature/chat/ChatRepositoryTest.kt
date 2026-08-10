// ChatRepository unit tests (§7) — channel/message load, optimistic send (pending
// -> promoted / failed), realtime reconcile (dedupe by id, promote a pending row,
// delete, membership no-ops), and the injected transport wiring. Mirrors chat.test.ts.
package jp.developershub.dub.mo2.feature.chat

import jp.developershub.dub.mo2.core.model.ChannelId
import jp.developershub.dub.mo2.core.model.ChatChannel
import jp.developershub.dub.mo2.core.model.ChatRealtimeEvent
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatRepositoryTest {

    private var seq = 0
    private fun repo(
        fake: FakeMobileBffClient,
        transport: ChatRealtimeTransport? = null,
    ): ChatRepository {
        seq = 0
        return ChatRepository(
            client = fake,
            transport = transport,
            now = { "2026-08-09T00:00:00Z" },
            localId = { "local_${++seq}" },
        )
    }

    private val created = ChatRealtimeEvent.MessageCreated(
        channelId = "chn_1", messageId = "m1", authorId = "usr_2", body = "hey", at = "2026-08-09T00:00:00Z",
    )

    @Test
    fun `loadChannels populates the channel flow`() = runTest {
        val fake = FakeMobileBffClient(
            channelsPage = listOf(ChatChannel("chn_1", "general", "2026-08-09T00:00:00Z")),
        )
        val repo = repo(fake)
        repo.loadChannels()
        assertEquals(1, repo.channels.value.size)
        assertEquals("general", repo.channels.value.first().name)
    }

    @Test
    fun `loadMessages populates entries as sent`() = runTest {
        val fake = FakeMobileBffClient(messagesPage = listOf(message("m1", "hi"), message("m2", "yo")))
        val repo = repo(fake)
        repo.loadMessages("chn_1")
        val entries = repo.messages("chn_1").value
        assertEquals(listOf(ChatSendState.SENT, ChatSendState.SENT), entries.map { it.state })
        assertEquals(listOf("hi", "yo"), entries.map { it.message.body })
    }

    @Test
    fun `send shows pending then promotes to the server message on ack`() = runTest {
        val fake = FakeMobileBffClient(onPostMessage = { _, _ -> message("m_server", "hello") })
        val repo = repo(fake)
        val result = repo.sendMessage("chn_1", "usr_1", "hello")

        assertTrue(result is ChatSendResult.Ok)
        val after = repo.messages("chn_1").value
        assertEquals(1, after.size) // promoted in place, not duplicated
        assertEquals(ChatSendState.SENT, after[0].state)
        assertEquals("m_server", after[0].message.id)
        assertNull(after[0].localId)
        assertEquals("hello", fake.lastPostedBody)
    }

    @Test
    fun `send marks the row failed and returns the error when POST fails`() = runTest {
        val fake = FakeMobileBffClient(
            onPostMessage = { _, _ -> throw AppErrorException(AppError.Server("INTERNAL", null)) },
        )
        val repo = repo(fake)
        val result = repo.sendMessage("chn_1", "usr_1", "oops")

        assertTrue(result is ChatSendResult.Failure)
        result as ChatSendResult.Failure
        assertTrue(result.error is AppError.Server)
        assertEquals("local_1", result.localId)
        val entries = repo.messages("chn_1").value
        assertEquals(1, entries.size)
        assertEquals(ChatSendState.FAILED, entries[0].state) // retained for retry
    }

    @Test
    fun `realtime message-created appends and is idempotent`() = runTest {
        val repo = repo(FakeMobileBffClient())
        repo.applyRealtimeEvent(created)
        repo.applyRealtimeEvent(created)
        val entries = repo.messages("chn_1").value
        assertEquals(1, entries.size)
        assertEquals("m1", entries[0].message.id)
        assertEquals(ChatSendState.SENT, entries[0].state)
    }

    @Test
    fun `realtime message-created promotes a matching pending optimistic row`() = runTest(UnconfinedTestDispatcher()) {
        val gate = CompletableDeferred<jp.developershub.dub.mo2.core.model.ChatMessage>()
        val fake = FakeMobileBffClient(postGate = gate)
        val repo = repo(fake)

        val pending = async { repo.sendMessage("chn_1", "usr_1", "hello") }
        // optimistic pending row visible
        assertEquals(ChatSendState.PENDING, repo.messages("chn_1").value.single().state)

        // server broadcasts the same message over the WS before the POST response lands
        repo.applyRealtimeEvent(
            ChatRealtimeEvent.MessageCreated("chn_1", "m_real", "usr_1", "hello", "2026-08-09T00:00:00Z"),
        )
        var entries = repo.messages("chn_1").value
        assertEquals(1, entries.size) // promoted in place
        assertEquals("m_real", entries[0].message.id)
        assertEquals(ChatSendState.SENT, entries[0].state)

        // now the POST ack (same id) resolves -> still exactly one row
        gate.complete(message("m_real", "hello"))
        pending.await()
        entries = repo.messages("chn_1").value
        assertEquals(1, entries.size)
        assertEquals("m_real", entries[0].message.id)
    }

    @Test
    fun `realtime message-deleted removes the message`() = runTest {
        val repo = repo(FakeMobileBffClient())
        repo.applyRealtimeEvent(created)
        repo.applyRealtimeEvent(
            ChatRealtimeEvent.MessageDeleted("chn_1", "m1", "2026-08-09T00:01:00Z"),
        )
        assertEquals(0, repo.messages("chn_1").value.size)
    }

    @Test
    fun `membership events are no-ops for the message store`() = runTest {
        val repo = repo(FakeMobileBffClient())
        repo.applyRealtimeEvent(ChatRealtimeEvent.MemberAdded("chn_1", "usr_3", "2026-08-09T00:00:00Z"))
        repo.applyRealtimeEvent(ChatRealtimeEvent.MemberRemoved("chn_1", "usr_3", "2026-08-09T00:00:00Z"))
        assertEquals(0, repo.messages("chn_1").value.size)
    }

    @Test
    fun `connectRealtime wires the injected transport and disconnect stops delivery`() = runTest {
        var handler: ((ChatRealtimeEvent) -> Unit)? = null
        var disconnected = false
        val transport = object : ChatRealtimeTransport {
            override fun connect(channelId: ChannelId, onEvent: (ChatRealtimeEvent) -> Unit): RealtimeDisconnect {
                handler = onEvent
                return RealtimeDisconnect { disconnected = true }
            }
        }
        val repo = repo(FakeMobileBffClient(), transport)
        val stop = repo.connectRealtime("chn_1")
        requireNotNull(handler).invoke(
            ChatRealtimeEvent.MessageCreated("chn_1", "m1", "usr_2", "via ws", "2026-08-09T00:00:00Z"),
        )
        assertEquals("via ws", repo.messages("chn_1").value.single().message.body)
        stop.disconnect()
        assertTrue(disconnected)
    }

    @Test
    fun `connectRealtime is a no-op when no transport is injected`() = runTest {
        val repo = repo(FakeMobileBffClient())
        repo.connectRealtime("chn_1").disconnect() // should not throw
    }
}
