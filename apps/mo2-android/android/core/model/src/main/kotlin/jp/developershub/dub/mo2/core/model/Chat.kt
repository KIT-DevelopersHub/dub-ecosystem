// Mirror of @dub/types `chat` namespace (packages/types/src/chat.ts).
// chat-service owns this namespace. The realtime WS wire contract is frozen;
// channel/message CRUD DTOs are STUB pending 9-C activation but consumed as-is.
// ChatRealtimeEvent is the DO-direct WS wire shape (theme11, gateway-bypassed);
// the app-layer OkHttp transport decodes raw frames into it, so it is a plain
// sealed type here (the reconcile logic in ChatRepository owns it, not Retrofit).
package jp.developershub.dub.mo2.core.model

import kotlinx.serialization.Serializable

@Serializable
data class ChatChannel(
    val id: ChannelId,
    val name: String,
    val createdAt: ISODateTime,
)

@Serializable
data class ChatMessage(
    val id: MessageId,
    val channelId: ChannelId,
    val authorId: UserId,
    val body: String,
    val createdAt: ISODateTime,
)

@Serializable
data class WsTicketResponse(
    val ticket: String, // short-lived; verified by the ChatRoom DO
    val doUrl: String, // absolute URL to the Durable Object (DO-direct, gateway bypassed)
    val expiresAt: ISODateTime,
)

/**
 * Server-internal fanout AND client WS wire contract (frozen · RT裁定#4). Decoded
 * from the DO-direct socket by the app-layer transport; the client-core reconcile
 * logic pattern-matches on [kind].
 */
sealed interface ChatRealtimeEvent {
    val channelId: ChannelId
    val at: ISODateTime

    data class MessageCreated(
        override val channelId: ChannelId,
        val messageId: MessageId,
        val authorId: UserId,
        val body: String,
        override val at: ISODateTime,
    ) : ChatRealtimeEvent

    data class MessageDeleted(
        override val channelId: ChannelId,
        val messageId: MessageId,
        override val at: ISODateTime,
    ) : ChatRealtimeEvent

    data class MemberAdded(
        override val channelId: ChannelId,
        val userId: UserId,
        override val at: ISODateTime,
    ) : ChatRealtimeEvent

    data class MemberRemoved(
        override val channelId: ChannelId,
        val userId: UserId,
        override val at: ISODateTime,
    ) : ChatRealtimeEvent
}
