// Test double for MobileBffClient — configurable per-method behavior so repo/VM
// tests run on the JVM without a server. Unused endpoints throw.
package jp.developershub.dub.mo2.feature.tasks

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
    var myTasks: List<TaskSummary> = emptyList(),
    var onUpdate: (suspend (id: String, status: TaskStatus, baseVersion: Int) -> Task)? = null,
    var onGetTask: (suspend (id: String) -> Task)? = null,
) : MobileBffClient {
    var updateCalls = 0
        private set
    var getTaskCalls = 0
        private set

    override suspend fun getMyTasks(cursor: String?): Paginated<TaskSummary> =
        Paginated(items = myTasks, nextCursor = null)

    override suspend fun getTask(id: String): Task {
        getTaskCalls++
        return onGetTask?.invoke(id) ?: error("getTask not configured")
    }

    override suspend fun updateTaskStatus(id: String, status: TaskStatus, baseVersion: Int): Task {
        updateCalls++
        return onUpdate?.invoke(id, status, baseVersion) ?: error("updateTaskStatus not configured")
    }

    // ---- unused in these tests ----
    override suspend fun exchange(code: String): MobileAuthTokenResponse = notImpl()
    override suspend fun logout() = notImpl()
    override suspend fun getHome(): MobileHomeResponse = notImpl()
    override suspend fun getEvents(cursor: String?): Paginated<EventSummary> = notImpl()
    override suspend fun getEventOverview(eventId: String): MobileEventOverviewResponse = notImpl()
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

fun task(
    id: String,
    status: TaskStatus,
    version: Int = 1,
    title: String = "T-$id",
): Task = Task(
    id = id,
    eventId = "evt_1",
    title = title,
    description = null,
    status = status,
    priority = jp.developershub.dub.mo2.core.model.TaskPriority.MEDIUM,
    assigneeId = "usr_me",
    dueAt = null,
    origin = jp.developershub.dub.mo2.core.model.TaskOrigin.INTERNAL,
    archivedAt = null,
    createdAt = "2026-08-09T00:00:00Z",
    updatedAt = "2026-08-09T00:00:00Z",
    version = version,
)

fun summary(id: String, status: TaskStatus, title: String = "T-$id"): TaskSummary =
    TaskSummary(id = id, title = title, status = status, assigneeId = "usr_me")
