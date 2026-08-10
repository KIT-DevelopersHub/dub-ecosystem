// RetrofitMobileBffClient — production MobileBffClient. Auth-guarded calls run
// through AuthInterceptor (401 -> refresh once -> retry/logout); auth
// exchange/refresh do not (they mint/rotate the token themselves). Retrofit
// HttpException / IOException are normalized to AppErrorException so the guard
// and callers see AppError, never transport types. Mirrors bff-client.ts.
package jp.developershub.dub.mo2.core.network

import jp.developershub.dub.mo2.core.common.SessionStore
import jp.developershub.dub.mo2.core.model.ChatChannel
import jp.developershub.dub.mo2.core.model.ChatMessage
import jp.developershub.dub.mo2.core.model.DeviceDto
import jp.developershub.dub.mo2.core.model.EventSummary
import jp.developershub.dub.mo2.core.model.GanttChartDTO
import jp.developershub.dub.mo2.core.model.GanttViewState
import jp.developershub.dub.mo2.core.model.InboxItem
import jp.developershub.dub.mo2.core.model.ListInboxResponse
import jp.developershub.dub.mo2.core.model.MobileAuthExchangeBody
import jp.developershub.dub.mo2.core.model.MobileAuthRefreshBody
import jp.developershub.dub.mo2.core.model.MobileAuthTokenResponse
import jp.developershub.dub.mo2.core.model.MobileEventOverviewResponse
import jp.developershub.dub.mo2.core.model.MobileHomeResponse
import jp.developershub.dub.mo2.core.model.MobilePlatform
import jp.developershub.dub.mo2.core.model.Paginated
import jp.developershub.dub.mo2.core.model.PreferenceEntry
import jp.developershub.dub.mo2.core.model.PutGanttViewRequest
import jp.developershub.dub.mo2.core.model.RegisterDeviceRequest
import jp.developershub.dub.mo2.core.model.RegisterDeviceResponse
import jp.developershub.dub.mo2.core.model.Task
import jp.developershub.dub.mo2.core.model.TaskStatus
import jp.developershub.dub.mo2.core.model.TaskSummary
import jp.developershub.dub.mo2.core.model.WsTicketResponse
import retrofit2.HttpException
import java.io.IOException

class RetrofitMobileBffClient(
    private val api: MobileBffApi,
    private val store: SessionStore,
    onLogout: () -> Unit,
) : MobileBffClient {

    // refreshFn hits the api directly (no interceptor) to avoid recursion.
    private val auth = AuthInterceptor(
        store = store,
        refreshFn = { refreshToken ->
            mapErrors { api.refresh(MobileAuthRefreshBody(refreshToken)) }
        },
        onLogout = onLogout,
    )

    // ---- S1 auth (unauthenticated) ----
    override suspend fun exchange(code: String): MobileAuthTokenResponse {
        val res = mapErrors { api.exchange(MobileAuthExchangeBody(code, MobilePlatform.ANDROID)) }
        store.setSession(res.token, res.refreshToken)
        return res
    }

    override suspend fun logout() {
        try {
            mapErrors { api.logout() }
        } finally {
            store.clear()
        }
    }

    // ---- S2 home ----
    override suspend fun getHome(): MobileHomeResponse = guarded { api.getHome() }

    // ---- S3/S4 events ----
    override suspend fun getEvents(cursor: String?): Paginated<EventSummary> =
        guarded { api.getEvents(cursor) }

    override suspend fun getEventOverview(eventId: String): MobileEventOverviewResponse =
        guarded { api.getEventOverview(eventId) }

    // ---- S5/S6 tasks ----
    override suspend fun getMyTasks(cursor: String?): Paginated<TaskSummary> =
        guarded { api.getMyTasks(cursor = cursor) }

    override suspend fun getTask(id: String): Task = guarded { api.getTask(id) }

    override suspend fun updateTaskStatus(id: String, status: TaskStatus, baseVersion: Int): Task =
        guarded { api.updateTask(id, UpdateTaskStatusBody(baseVersion, status)) }

    // ---- S7 inbox ----
    override suspend fun getInbox(cursor: String?): ListInboxResponse =
        guarded { api.getInbox(cursor) }

    override suspend fun markRead(id: String): InboxItem = guarded { api.markRead(id) }

    override suspend fun markAllRead() = guarded { api.markAllRead() }

    // ---- S8 preferences ----
    override suspend fun getPreferences(): List<PreferenceEntry> = guarded { api.getPreferences() }

    override suspend fun updatePreferences(prefs: List<PreferenceEntry>): List<PreferenceEntry> =
        guarded { api.updatePreferences(UpdatePreferencesBody(prefs)) }

    // ---- S10 chat ----
    override suspend fun listChannels(cursor: String?): Paginated<ChatChannel> =
        guarded { api.listChannels(cursor) }

    override suspend fun listMessages(channelId: String, cursor: String?): Paginated<ChatMessage> =
        guarded { api.listMessages(channelId, cursor) }

    override suspend fun postMessage(channelId: String, body: String): ChatMessage =
        guarded { api.postMessage(channelId, PostMessageBody(body)) }

    override suspend fun getChatWsTicket(channelId: String): WsTicketResponse =
        guarded { api.getChatWsTicket(channelId) }

    // ---- S11 gantt ----
    override suspend fun getGantt(eventId: String): GanttChartDTO =
        guarded { api.getGantt(eventId) }

    override suspend fun getGanttView(eventId: String): GanttViewState =
        guarded { api.getGanttView(eventId) }

    override suspend fun saveGanttView(eventId: String, req: PutGanttViewRequest): GanttViewState =
        guarded { api.saveGanttView(eventId, req) }

    // ---- device registration (push) ----
    override suspend fun registerDevice(pushToken: String): RegisterDeviceResponse = guarded {
        val res = api.registerDevice(RegisterDeviceRequest(MobilePlatform.ANDROID, pushToken))
        store.setDeviceId(res.deviceId)
        res
    }

    override suspend fun listDevices(): List<DeviceDto> = guarded { api.listDevices() }

    override suspend fun deleteDevice(deviceId: String) = guarded { api.deleteDevice(deviceId) }

    /** Run an auth-guarded call: interceptor supplies/refreshes the bearer; errors mapped. */
    private suspend fun <T> guarded(block: suspend () -> T): T =
        auth.execute { mapErrors { block() } }

    /** Normalize Retrofit transport failures into AppErrorException. */
    private suspend fun <T> mapErrors(block: suspend () -> T): T {
        try {
            return block()
        } catch (e: HttpException) {
            val envelope = ErrorMapper.parseEnvelope(e.response()?.errorBody()?.string())
            val retryAfter = e.response()?.headers()?.get("Retry-After")
            throw AppErrorException(ErrorMapper.mapHttpError(e.code(), envelope, retryAfter))
        } catch (e: AppErrorException) {
            throw e
        } catch (e: IOException) {
            throw AppErrorException(ErrorMapper.mapNetworkError(e))
        }
    }
}
