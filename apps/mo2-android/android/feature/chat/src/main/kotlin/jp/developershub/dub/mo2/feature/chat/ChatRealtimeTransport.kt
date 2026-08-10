// ChatRealtimeTransport — injected DO-direct realtime boundary (theme11, gateway-
// bypassed). The client-core reconcile logic (ChatRepository) owns only the
// application of ChatRealtimeEvent; the actual socket is supplied by the :app
// module as an OkHttp WebSocket that first mints a ws-ticket via
// MobileBffClient.getChatWsTicket, connects to WsTicketResponse.doUrl, and decodes
// frames into ChatRealtimeEvent. Stubbed in unit tests.
package jp.developershub.dub.mo2.feature.chat

import jp.developershub.dub.mo2.core.model.ChannelId
import jp.developershub.dub.mo2.core.model.ChatRealtimeEvent

fun interface RealtimeDisconnect {
    fun disconnect()
}

interface ChatRealtimeTransport {
    /** Connect a channel's realtime stream; returns a disconnect handle. */
    fun connect(channelId: ChannelId, onEvent: (ChatRealtimeEvent) -> Unit): RealtimeDisconnect
}
