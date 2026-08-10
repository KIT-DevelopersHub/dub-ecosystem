// ChatRepository (S10) — channel list + per-channel message store with optimistic
// send, mirroring TaskRepository's observable single-source-is-MO3 boundary (§2-2)
// and 1:1 with chat.ts. Realtime is a DO-direct WebSocket (theme11); at this layer
// the WS is an injected ChatRealtimeTransport (stubbed in tests), so this module
// owns only the reconcile logic — dedupe by server id, promote a matching pending
// optimistic row, apply message.deleted. The Kotlin StateFlow<List<ChatMessageEntry>>
// boundary a Compose state collects replaces the JS listener set.
package jp.developershub.dub.mo2.feature.chat

import jp.developershub.dub.mo2.core.model.ChannelId
import jp.developershub.dub.mo2.core.model.ChatChannel
import jp.developershub.dub.mo2.core.model.ChatMessage
import jp.developershub.dub.mo2.core.model.ChatRealtimeEvent
import jp.developershub.dub.mo2.core.model.MessageId
import jp.developershub.dub.mo2.core.model.UserId
import jp.developershub.dub.mo2.core.network.AppError
import jp.developershub.dub.mo2.core.network.AppErrorException
import jp.developershub.dub.mo2.core.network.MobileBffClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.atomic.AtomicInteger

/** Delivery state of a message row (optimistic send lifecycle). */
enum class ChatSendState { PENDING, SENT, FAILED }

/** A message plus its client-side delivery state. `localId` is set while pending/failed. */
data class ChatMessageEntry(
    val message: ChatMessage,
    val state: ChatSendState,
    val localId: String? = null,
)

sealed interface ChatSendResult {
    data class Ok(val message: ChatMessage) : ChatSendResult
    /** entry left in FAILED state for retry. */
    data class Failure(val error: AppError, val localId: String) : ChatSendResult
}

class ChatRepository(
    private val client: MobileBffClient,
    private val transport: ChatRealtimeTransport? = null,
    private val now: () -> String = { java.time.Instant.now().toString() },
    localId: (() -> String)? = null,
) {
    private val localSeq = AtomicInteger(0)
    private val mintLocalId: () -> String = localId ?: { "local_${localSeq.incrementAndGet()}" }

    // ---- channels ----
    private val _channels = MutableStateFlow<List<ChatChannel>>(emptyList())
    val channels: StateFlow<List<ChatChannel>> = _channels.asStateFlow()

    // ---- messages (one StateFlow per opened channel) ----
    private val messageFlows = HashMap<ChannelId, MutableStateFlow<List<ChatMessageEntry>>>()

    private fun flowFor(channelId: ChannelId): MutableStateFlow<List<ChatMessageEntry>> =
        messageFlows.getOrPut(channelId) { MutableStateFlow(emptyList()) }

    fun messages(channelId: ChannelId): StateFlow<List<ChatMessageEntry>> = flowFor(channelId).asStateFlow()

    suspend fun loadChannels() {
        _channels.value = client.listChannels().items
    }

    /** Replace a channel's history from the server (pull-to-refresh / initial open). */
    suspend fun loadMessages(channelId: ChannelId) {
        val page = client.listMessages(channelId)
        flowFor(channelId).value = page.items.map { ChatMessageEntry(it, ChatSendState.SENT) }
    }

    /**
     * Optimistic send: append a pending row immediately, POST, then promote to the
     * authoritative server message on 200 (or mark failed on error). If realtime has
     * already delivered the same message, the pending row is reconciled, not duplicated.
     */
    suspend fun sendMessage(channelId: ChannelId, authorId: UserId, body: String): ChatSendResult {
        val localId = mintLocalId()
        val optimistic = ChatMessage(
            id = localId,
            channelId = channelId,
            authorId = authorId,
            body = body,
            createdAt = now(),
        )
        append(channelId, ChatMessageEntry(optimistic, ChatSendState.PENDING, localId))

        return try {
            val saved = client.postMessage(channelId, body)
            promote(channelId, localId, saved)
            ChatSendResult.Ok(saved)
        } catch (err: Throwable) {
            val appError = (err as? AppErrorException)?.appError ?: AppError.Server("UNKNOWN", null)
            mark(channelId, localId, ChatSendState.FAILED)
            ChatSendResult.Failure(appError, localId)
        }
    }

    // ---- realtime ----
    /** Wire the injected WS transport for a channel; returns a disconnect handle. */
    fun connectRealtime(channelId: ChannelId): RealtimeDisconnect =
        transport?.connect(channelId) { applyRealtimeEvent(it) } ?: RealtimeDisconnect {}

    /** Reconcile a frozen ChatRealtimeEvent into the message store (idempotent). */
    fun applyRealtimeEvent(e: ChatRealtimeEvent) {
        when (e) {
            is ChatRealtimeEvent.MessageCreated -> upsertFromRealtime(
                e.channelId,
                ChatMessage(e.messageId, e.channelId, e.authorId, e.body, e.at),
            )
            is ChatRealtimeEvent.MessageDeleted -> remove(e.channelId, e.messageId)
            // Membership changes do not affect the message store (out of P0 client-core).
            is ChatRealtimeEvent.MemberAdded, is ChatRealtimeEvent.MemberRemoved -> Unit
        }
    }

    // ---- internals ----
    private fun append(channelId: ChannelId, entry: ChatMessageEntry) {
        val flow = flowFor(channelId)
        flow.value = flow.value + entry
    }

    /** POST ack: replace the pending local row with the authoritative server message. */
    private fun promote(channelId: ChannelId, localId: String, saved: ChatMessage) {
        val flow = flowFor(channelId)
        val arr = flow.value.toMutableList()
        val idx = arr.indexOfFirst { it.localId == localId }
        if (arr.any { it.message.id == saved.id && it.localId == null }) {
            // Realtime already delivered it -> drop the temp row, keep the confirmed one.
            if (idx != -1) arr.removeAt(idx)
        } else if (idx != -1) {
            arr[idx] = ChatMessageEntry(saved, ChatSendState.SENT)
        } else {
            arr.add(ChatMessageEntry(saved, ChatSendState.SENT))
        }
        flow.value = arr
    }

    private fun mark(channelId: ChannelId, localId: String, state: ChatSendState) {
        val flow = flowFor(channelId)
        val arr = flow.value.toMutableList()
        val idx = arr.indexOfFirst { it.localId == localId }
        if (idx != -1) {
            arr[idx] = arr[idx].copy(state = state)
            flow.value = arr
        }
    }

    /** Realtime insert: dedupe by server id; promote a matching pending optimistic row. */
    private fun upsertFromRealtime(channelId: ChannelId, incoming: ChatMessage) {
        val flow = flowFor(channelId)
        val arr = flow.value.toMutableList()
        if (arr.any { it.message.id == incoming.id && it.localId == null }) return // already have it
        val pendingIdx = arr.indexOfFirst {
            it.localId != null && it.message.authorId == incoming.authorId && it.message.body == incoming.body
        }
        if (pendingIdx != -1) {
            arr[pendingIdx] = ChatMessageEntry(incoming, ChatSendState.SENT) // promote in place
        } else {
            arr.add(ChatMessageEntry(incoming, ChatSendState.SENT))
        }
        flow.value = arr
    }

    private fun remove(channelId: ChannelId, messageId: MessageId) {
        val flow = messageFlows[channelId] ?: return
        val arr = flow.value.toMutableList()
        val idx = arr.indexOfFirst { it.message.id == messageId }
        if (idx != -1) {
            arr.removeAt(idx)
            flow.value = arr
        }
    }
}
