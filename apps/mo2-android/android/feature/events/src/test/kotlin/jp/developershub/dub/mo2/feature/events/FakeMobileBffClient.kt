// Test double for MobileBffClient scoped to events tests — configurable events
// endpoints; unused endpoints throw. Mirrors the fakes in the other feature modules.
package jp.developershub.dub.mo2.feature.events

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
    var onGetEvents: (suspend () -> List<EventSummary>)? = null,
    var onGetOverview: (suspend (eventId: String) -> MobileEventOverviewResponse)? = null,
) : MobileBffClient {
    override suspend fun getEvents(cursor: String?): Paginated<EventSummary> =
        Paginated(items = onGetEvents?.invoke() ?: error("getEvents not configured"), nextCursor = null)

    override suspend fun getEventOverview(eventId: String): MobileEventOverviewResponse =
        onGetOverview?.invoke(eventId) ?: error("getEventOverview not configured")

    // ---- unused in these tests ----
    override suspend fun exchange(code: String): MobileAuthTokenResponse = notImpl()
    override suspend fun logout() = notImpl()
    override suspend fun getHome(): MobileHomeResponse = notImpl()
    override suspend fun getMyTasks(cursor: String?): Paginated<TaskSummary> = notImpl()
    override suspend fun getTask(id: String): Task = notImpl()
    override suspend fun updateTaskStatus(id: String, status: TaskStatus, baseVersion: Int): Task = notImpl()
    override suspend fun getInbox(cursor: String?): ListInboxResponse = notImpl()
    override suspend fun markRead(id: String): InboxItem = notImpl()
    override suspend fun markAllRead() = notImpl()
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
