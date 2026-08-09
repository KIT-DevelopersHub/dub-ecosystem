// AuthInterceptor — single-token 401 handling (§6, §7). 1:1 port of
// auth-interceptor.ts. On Unauthorized: refresh exactly once (rotating token),
// retry once; on refresh failure or a second 401, clear the session and emit a
// logout event (drive back to S1). Bearer only. Concurrent 401s coalesce onto a
// single refresh round-trip (a Mutex + shared Deferred replaces the JS
// inflight-promise). Framework-agnostic; core:network wires it into the client.
package jp.developershub.dub.mo2.core.network

import jp.developershub.dub.mo2.core.common.SessionStore
import jp.developershub.dub.mo2.core.model.MobileAuthTokenResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Rotating-token refresh call (hits the transport directly, no interceptor). */
typealias RefreshFn = suspend (refreshToken: String) -> MobileAuthTokenResponse

class AuthInterceptor(
    private val store: SessionStore,
    private val refreshFn: RefreshFn,
    private val onLogout: () -> Unit,
) {
    private val mutex = Mutex()
    private var inflightRefresh: CompletableDeferred<Boolean>? = null

    /** send receives the current bearer token; it throws AppErrorException on failure. */
    suspend fun <T> execute(send: suspend (token: String?) -> T): T {
        try {
            return send(store.getToken())
        } catch (err: AppErrorException) {
            if (!isUnauthorized(err)) throw err
            val refreshed = refreshOnce()
            if (!refreshed) {
                logout()
                throw err
            }
            try {
                return send(store.getToken())
            } catch (retryErr: AppErrorException) {
                if (isUnauthorized(retryErr)) logout()
                throw retryErr
            }
        }
    }

    /** Coalesced single refresh: concurrent 401s share one refresh round-trip. */
    private suspend fun refreshOnce(): Boolean {
        val (deferred, isOwner) = mutex.withLock {
            val existing = inflightRefresh
            if (existing != null) {
                existing to false
            } else {
                val d = CompletableDeferred<Boolean>()
                inflightRefresh = d
                d to true
            }
        }
        if (!isOwner) return deferred.await()

        val result = try {
            val rt = store.getRefreshToken()
            if (rt == null) {
                false
            } else {
                try {
                    val res = refreshFn(rt)
                    store.setSession(res.token, res.refreshToken)
                    true
                } catch (_: Throwable) {
                    false
                }
            }
        } finally {
            mutex.withLock { inflightRefresh = null }
        }
        deferred.complete(result)
        return result
    }

    private fun logout() {
        store.clear()
        onLogout()
    }

    private fun isUnauthorized(err: AppErrorException): Boolean =
        err.appError is AppError.Unauthorized
}
