// MobileBffApi — Retrofit surface for MO3 mobile-bff `/m/v1/*` (§1: MO2 knows
// only MO3). Suspend functions return the parsed body; non-2xx surfaces as
// retrofit2.HttpException and is normalized to AppError by the client impl.
// Base URL already carries the MOBILE_API_PREFIX, so paths are prefix-relative.
package jp.developershub.dub.mo2.core.network

import jp.developershub.dub.mo2.core.model.DeviceDto
import jp.developershub.dub.mo2.core.model.EventSummary
import jp.developershub.dub.mo2.core.model.InboxItem
import jp.developershub.dub.mo2.core.model.ListInboxResponse
import jp.developershub.dub.mo2.core.model.MobileAuthExchangeBody
import jp.developershub.dub.mo2.core.model.MobileAuthRefreshBody
import jp.developershub.dub.mo2.core.model.MobileAuthTokenResponse
import jp.developershub.dub.mo2.core.model.MobileEventOverviewResponse
import jp.developershub.dub.mo2.core.model.MobileHomeResponse
import jp.developershub.dub.mo2.core.model.Paginated
import jp.developershub.dub.mo2.core.model.PreferenceEntry
import jp.developershub.dub.mo2.core.model.RegisterDeviceRequest
import jp.developershub.dub.mo2.core.model.RegisterDeviceResponse
import jp.developershub.dub.mo2.core.model.Task
import jp.developershub.dub.mo2.core.model.TaskStatus
import jp.developershub.dub.mo2.core.model.TaskSummary
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

@Serializable
data class UpdateTaskStatusBody(val version: Int, val status: TaskStatus)

@Serializable
data class UpdatePreferencesBody(val preferences: List<PreferenceEntry>)

interface MobileBffApi {
    // ---- S1 auth (unauthenticated) ----
    @POST("auth/exchange")
    suspend fun exchange(@Body body: MobileAuthExchangeBody): MobileAuthTokenResponse

    @POST("auth/refresh")
    suspend fun refresh(@Body body: MobileAuthRefreshBody): MobileAuthTokenResponse

    @POST("auth/logout")
    suspend fun logout()

    // ---- S2 home (aggregate) ----
    @GET("bff/home")
    suspend fun getHome(): MobileHomeResponse

    // ---- S3/S4 events ----
    @GET("events")
    suspend fun getEvents(@Query("cursor") cursor: String?): Paginated<EventSummary>

    @GET("bff/events/{id}")
    suspend fun getEventOverview(@Path("id") eventId: String): MobileEventOverviewResponse

    // ---- S5/S6 tasks ----
    @GET("tasks")
    suspend fun getMyTasks(
        @Query("assignee") assignee: String = "me",
        @Query("cursor") cursor: String? = null,
    ): Paginated<TaskSummary>

    @GET("tasks/{id}")
    suspend fun getTask(@Path("id") id: String): Task

    @PATCH("tasks/{id}")
    suspend fun updateTask(@Path("id") id: String, @Body body: UpdateTaskStatusBody): Task

    // ---- S7 inbox ----
    @GET("inbox")
    suspend fun getInbox(@Query("cursor") cursor: String?): ListInboxResponse

    @PATCH("inbox/{id}/read")
    suspend fun markRead(@Path("id") id: String): InboxItem

    @POST("inbox/read-all")
    suspend fun markAllRead()

    // ---- S8 preferences ----
    @GET("preferences")
    suspend fun getPreferences(): List<PreferenceEntry>

    @PATCH("preferences")
    suspend fun updatePreferences(@Body body: UpdatePreferencesBody): List<PreferenceEntry>

    // ---- device registration (push) ----
    @POST("devices")
    suspend fun registerDevice(@Body body: RegisterDeviceRequest): RegisterDeviceResponse

    @GET("devices")
    suspend fun listDevices(): List<DeviceDto>

    @DELETE("devices/{id}")
    suspend fun deleteDevice(@Path("id") id: String)
}
