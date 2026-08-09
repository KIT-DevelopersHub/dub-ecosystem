// MobileBffClient — the single network entry point (§1: MO2 knows only MO3).
// Interface so feature repositories/ViewModels depend on a boundary that unit
// tests can fake without a server. RetrofitMobileBffClient is the production impl.
// Mirrors the method surface of bff-client.ts.
package jp.developershub.dub.mo2.core.network

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

interface MobileBffClient {
    // S1 auth
    suspend fun exchange(code: String): MobileAuthTokenResponse
    suspend fun logout()
    // S2 home
    suspend fun getHome(): MobileHomeResponse
    // S3/S4 events
    suspend fun getEvents(cursor: String? = null): Paginated<EventSummary>
    suspend fun getEventOverview(eventId: String): MobileEventOverviewResponse
    // S5/S6 tasks
    suspend fun getMyTasks(cursor: String? = null): Paginated<TaskSummary>
    suspend fun getTask(id: String): Task
    /** Single online PATCH + baseVersion (theme3 D4). 409 -> AppError.Conflict. */
    suspend fun updateTaskStatus(id: String, status: TaskStatus, baseVersion: Int): Task
    // S7 inbox
    suspend fun getInbox(cursor: String? = null): ListInboxResponse
    suspend fun markRead(id: String): InboxItem
    suspend fun markAllRead()
    // S8 preferences
    suspend fun getPreferences(): List<PreferenceEntry>
    suspend fun updatePreferences(prefs: List<PreferenceEntry>): List<PreferenceEntry>
    // devices (push)
    suspend fun registerDevice(pushToken: String): RegisterDeviceResponse
    suspend fun listDevices(): List<DeviceDto>
    suspend fun deleteDevice(deviceId: String)
}
