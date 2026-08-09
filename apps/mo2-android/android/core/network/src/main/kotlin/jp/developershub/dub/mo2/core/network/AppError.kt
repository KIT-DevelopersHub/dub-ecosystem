// AppError — client-side error model (§6). 1:1 Kotlin port of the `AppError`
// union in errors.ts. Open-ended: unknown/unmapped codes and statuses fall
// through to Server. Carried across the client boundary by AppErrorException.
package jp.developershub.dub.mo2.core.network

sealed interface AppError {
    /** 401 -> refresh once, then re-login. */
    data class Unauthorized(val reAuth: Boolean) : AppError

    /** 403 -> hide/disable UI. */
    data class Forbidden(val code: String) : AppError

    /** 409 -> rollback optimistic UI, refetch latest. */
    data class Conflict(val serverVersion: Int?) : AppError

    /** 400 -> field-level form errors. */
    data class Validation(val fields: Map<String, String>) : AppError

    /** 429 -> honor Retry-After, exp backoff (max 2). */
    data class RateLimited(val retryAfterSec: Int) : AppError

    /** timeout/offline -> cached view + banner. */
    data class Network(val retryable: Boolean) : AppError

    /** 5xx / unknown code -> show requestId. */
    data class Server(val code: String, val requestId: String?) : AppError
    // 後段: SyncCursorExpired (410 MOBILE_SYNC_CURSOR_EXPIRED -> full resync) は /sync 実装波で追加。
}

/** True if the error warrants a single silent refresh+retry (AuthInterceptor). */
fun AppError.isReauthable(): Boolean = this is AppError.Unauthorized && this.reAuth

/** Thrown carrier for an AppError across the client boundary. */
class AppErrorException(val appError: AppError) : Exception(appError::class.simpleName)
