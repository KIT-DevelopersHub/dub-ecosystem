// Test double for MobileBffClient scoped to chat tests — configurable chat
// endpoints; unused endpoints throw. Mirrors the fakes in feature:home/tasks/gantt.
package jp.developershub.dub.mo2.feature.chat

import jp.developershub.dub.mo2.core.model.ChatChannel
import jp.developershub.dub.mo2.core.model.ChatMessage
import jp.developershub.dub.mo2.core.model.DeviceDto
import jp.developershub.dub.mo2.core.model.EventSummary
import jp.developershub.dub.mo2.core.model.GanttChartDTO
import jp.developershub.dub.mo2.core.model.GanttViewState
import jp.developershub.dub.mo2.core.model.InboxItem
import jp.developershub.dub.mo2.core.model.ListInboxResponse
import jp.developershub.dub.mo2.core.model.MobileAuthTokenResponse
import jp.developershub.dub.mo2.core.model.MobileEventOverviewResponse
import jp.developershub.dub.mo2.core.model.MobileHomeResponse
import jp.developershub.dub.mo2.core.model.Paginated
import jp.developershub.dub.mo2.core.model.PreferenceEntry
import jp.developershub.dub.mo2.core.model.PutGanttViewRequest
import jp.developershub.dub.mo2.core.model.RegisterDeviceResponse
import jp.developershub.dub.mo2.core.model.Task
import jp.developershub.dub.mo2.core.model.TaskStatus
import jp.developershub.dub.mo2.core.model.TaskSummary
import jp.developershub.dub.mo2.core.model.WsTicketResponse
import jp.developershub.dub.mo2.core.network.MobileBffClient
import kotlinx.coroutines.CompletableDeferred

class FakeMobileBffClient(
    var channelsPage: List<ChatChannel> = emptyList(),
    var messagesPage: List<ChatMessage> = emptyList(),
    var onPostMessage: (suspend (channelId: String, body: String) -> ChatMessage)? = null,
    /** When set, postMessage suspends on this until completed (models a held-open POST). */
    var postGate: CompletableDeferred<ChatMessage>? = null,
) : MobileBffClient {
    var lastPostedBody: String? = null
        private set

    override suspend fun listChannels(cursor: String?): Paginated<ChatChannel> =
        Paginated(items = channelsPage, nextCursor = null)

    override suspend fun listMessages(channelId: String, cursor: String?): Paginated<ChatMessage> =
        Paginated(items = messagesPage, nextCursor = null)

    override suspend fun postMessage(channelId: String, body: String): ChatMessage {
        lastPostedBody = body
        postGate?.let { return it.await() }
        return onPostMessage?.invoke(channelId, body) ?: error("postMessage not configured")
    }

    override suspend fun getChatWsTicket(channelId: String): WsTicketResponse = notImpl()

    // ---- unused in these tests ----
    override suspend fun exchange(code: String): MobileAuthTokenResponse = notImpl()
    override suspend fun logout() = notImpl()
    override suspend fun getHome(): MobileHomeResponse = notImpl()
    override suspend fun getEvents(cursor: String?): Paginated<EventSummary> = notImpl()
    override suspend fun getEventOverview(eventId: String): MobileEventOverviewResponse = notImpl()
    override suspend fun getMyTasks(cursor: String?): Paginated<TaskSummary> = notImpl()
    override suspend fun getTask(id: String): Task = notImpl()
    override suspend fun updateTaskStatus(id: String, status: TaskStatus, baseVersion: Int): Task = notImpl()
    override suspend fun getInbox(cursor: String?): ListInboxResponse = notImpl()
    override suspend fun markRead(id: String): InboxItem = notImpl()
    override suspend fun markAllRead() = notImpl()
    override suspend fun getPreferences(): List<PreferenceEntry> = notImpl()
    override suspend fun updatePreferences(prefs: List<PreferenceEntry>): List<PreferenceEntry> = notImpl()
    override suspend fun getGantt(eventId: String): GanttChartDTO = notImpl()
    override suspend fun getGanttView(eventId: String): GanttViewState = notImpl()
    override suspend fun saveGanttView(eventId: String, req: PutGanttViewRequest): GanttViewState = notImpl()
    override suspend fun registerDevice(pushToken: String): RegisterDeviceResponse = notImpl()
    override suspend fun listDevices(): List<DeviceDto> = notImpl()
    override suspend fun deleteDevice(deviceId: String) = notImpl()

    private fun notImpl(): Nothing = throw NotImplementedError("not used in this test")
}

fun message(
    id: String,
    body: String,
    authorId: String = "usr_1",
    channelId: String = "chn_1",
): ChatMessage = ChatMessage(
    id = id,
    channelId = channelId,
    authorId = authorId,
    body = body,
    createdAt = "2026-08-09T00:00:00Z",
)
