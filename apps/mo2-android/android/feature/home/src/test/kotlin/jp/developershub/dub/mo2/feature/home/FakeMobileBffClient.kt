// Test double for MobileBffClient scoped to HomeViewModel tests.
package jp.developershub.dub.mo2.feature.home

import jp.developershub.dub.mo2.core.model.DeviceDto
import jp.developershub.dub.mo2.core.model.EventSummary
import jp.developershub.dub.mo2.core.model.InboxItem
import jp.developershub.dub.mo2.core.model.ListInboxResponse
import jp.developershub.dub.mo2.core.model.MobileAuthTokenResponse
import jp.developershub.dub.mo2.core.model.MobileEventOverviewResponse
import jp.developershub.dub.mo2.core.model.MobileHomeResponse
import jp.developershub.dub.mo2.core.model.Paginated
import jp.developershub.dub.mo2.core.model.PreferenceEntry
import jp.developershub.dub.mo2.core.model.RegisterDeviceResponse
import jp.developershub.dub.mo2.core.model.Task
import jp.developershub.dub.mo2.core.model.TaskStatus
import jp.developershub.dub.mo2.core.model.TaskSummary
import jp.developershub.dub.mo2.core.network.MobileBffClient

class FakeMobileBffClient(
    var onGetHome: (suspend () -> MobileHomeResponse)? = null,
) : MobileBffClient {
    override suspend fun getHome(): MobileHomeResponse =
        onGetHome?.invoke() ?: error("getHome not configured")

    override suspend fun exchange(code: String): MobileAuthTokenResponse = notImpl()
    override suspend fun logout() = notImpl()
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
    override suspend fun registerDevice(pushToken: String): RegisterDeviceResponse = notImpl()
    override suspend fun listDevices(): List<DeviceDto> = notImpl()
    override suspend fun deleteDevice(deviceId: String) = notImpl()

    private fun notImpl(): Nothing = throw NotImplementedError("not used in this test")
}
