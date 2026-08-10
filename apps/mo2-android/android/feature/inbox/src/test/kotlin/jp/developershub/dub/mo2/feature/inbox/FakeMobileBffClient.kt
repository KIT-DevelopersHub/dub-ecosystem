// Test double for MobileBffClient scoped to inbox tests — configurable inbox
// endpoints; unused endpoints throw. Mirrors the fakes in the other feature modules.
package jp.developershub.dub.mo2.feature.inbox

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

class FakeMobileBffClient(
    var inboxPage: List<InboxItem> = emptyList(),
    var onGetInbox: (suspend () -> List<InboxItem>)? = null,
    var onMarkRead: (suspend (id: String) -> InboxItem)? = null,
    var onMarkAllRead: (suspend () -> Unit)? = null,
) : MobileBffClient {
    var markReadCalls = 0
        private set
    var markAllCalls = 0
        private set

    override suspend fun getInbox(cursor: String?): ListInboxResponse =
        Paginated(items = onGetInbox?.invoke() ?: inboxPage, nextCursor = null)

    override suspend fun markRead(id: String): InboxItem {
        markReadCalls++
        return onMarkRead?.invoke(id) ?: inboxPage.first { it.id == id }.copy(readAt = "2026-08-09T00:00:00Z")
    }

    override suspend fun markAllRead() {
        markAllCalls++
        onMarkAllRead?.invoke()
    }

    // ---- unused in these tests ----
    override suspend fun exchange(code: String): MobileAuthTokenResponse = notImpl()
    override suspend fun logout() = notImpl()
    override suspend fun getHome(): MobileHomeResponse = notImpl()
    override suspend fun getEvents(cursor: String?): Paginated<EventSummary> = notImpl()
    override suspend fun getEventOverview(eventId: String): MobileEventOverviewResponse = notImpl()
    override suspend fun getMyTasks(cursor: String?): Paginated<TaskSummary> = notImpl()
    override suspend fun getTask(id: String): Task = notImpl()
    override suspend fun updateTaskStatus(id: String, status: TaskStatus, baseVersion: Int): Task = notImpl()
    override suspend fun getPreferences(): List<PreferenceEntry> = notImpl()
    override suspend fun updatePreferences(prefs: List<PreferenceEntry>): List<PreferenceEntry> = notImpl()
    override suspend fun listChannels(cursor: String?): Paginated<ChatChannel> = notImpl()
    override suspend fun listMessages(channelId: String, cursor: String?): Paginated<ChatMessage> = notImpl()
    override suspend fun postMessage(channelId: String, body: String): ChatMessage = notImpl()
    override suspend fun getChatWsTicket(channelId: String): WsTicketResponse = notImpl()
    override suspend fun getGantt(eventId: String): GanttChartDTO = notImpl()
    override suspend fun getGanttView(eventId: String): GanttViewState = notImpl()
    override suspend fun saveGanttView(eventId: String, req: PutGanttViewRequest): GanttViewState = notImpl()
    override suspend fun registerDevice(pushToken: String): RegisterDeviceResponse = notImpl()
    override suspend fun listDevices(): List<DeviceDto> = notImpl()
    override suspend fun deleteDevice(deviceId: String) = notImpl()

    private fun notImpl(): Nothing = throw NotImplementedError("not used in this test")
}

fun inboxItem(id: String, read: Boolean = false): InboxItem = InboxItem(
    id = id,
    type = "task.assigned",
    title = "Title $id",
    body = "Body $id",
    readAt = if (read) "2026-08-09T00:00:00Z" else null,
    createdAt = "2026-08-09T00:00:00Z",
)
