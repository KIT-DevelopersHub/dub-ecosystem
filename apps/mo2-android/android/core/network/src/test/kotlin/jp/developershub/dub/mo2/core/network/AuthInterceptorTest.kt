// AuthInterceptor unit tests (§7) — single-token 401 handling: passthrough,
// refresh-once-then-retry, logout when no refresh token, logout on a second 401,
// and coalescing of concurrent 401s onto one refresh. Mirrors auth-interceptor.test.ts.
package jp.developershub.dub.mo2.core.network

import jp.developershub.dub.mo2.core.common.InMemorySessionStore
import jp.developershub.dub.mo2.core.model.AuthClient
import jp.developershub.dub.mo2.core.model.MobileAuthTokenResponse
import jp.developershub.dub.mo2.core.model.SessionInfo
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun tokenResponse(token: String, refresh: String?) = MobileAuthTokenResponse(
    token = token,
    refreshToken = refresh,
    session = SessionInfo(userId = "usr_1", client = AuthClient.MOBILE, sessionExpiresAt = 0L),
)

private fun unauthorized() = AppErrorException(AppError.Unauthorized(reAuth = true))

class AuthInterceptorTest {

    @Test
    fun `passes through on success without refreshing`() = runTest {
        val store = InMemorySessionStore().apply { setSession("t0", "r0") }
        var refreshes = 0
        val auth = AuthInterceptor(store, { refreshes++; tokenResponse("t1", "r1") }, onLogout = {})

        val result = auth.execute { token -> "ok:$token" }

        assertEquals("ok:t0", result)
        assertEquals(0, refreshes)
    }

    @Test
    fun `refreshes once then retries with the new token`() = runTest {
        val store = InMemorySessionStore().apply { setSession("t0", "r0") }
        var refreshes = 0
        val auth = AuthInterceptor(store, { refreshes++; tokenResponse("t1", "r1") }, onLogout = {})

        var attempt = 0
        val result = auth.execute { token ->
            attempt++
            if (attempt == 1) throw unauthorized() else "ok:$token"
        }

        assertEquals("ok:t1", result) // retried with rotated token
        assertEquals(1, refreshes)
        assertEquals("t1", store.getToken())
        assertEquals("r1", store.getRefreshToken())
    }

    @Test
    fun `logs out and rethrows when there is no refresh token`() = runTest {
        val store = InMemorySessionStore().apply { setSession("t0", null) }
        var loggedOut = false
        val auth = AuthInterceptor(store, { tokenResponse("t1", "r1") }, onLogout = { loggedOut = true })

        var threw = false
        try {
            auth.execute { throw unauthorized() }
        } catch (e: AppErrorException) {
            threw = true
            assertTrue(e.appError is AppError.Unauthorized)
        }
        assertTrue(threw)
        assertTrue(loggedOut)
        assertNull(store.getToken())
    }

    @Test
    fun `logs out when the retry also 401s`() = runTest {
        val store = InMemorySessionStore().apply { setSession("t0", "r0") }
        var loggedOut = false
        val auth = AuthInterceptor(store, { tokenResponse("t1", "r1") }, onLogout = { loggedOut = true })

        var threw = false
        try {
            auth.execute { throw unauthorized() } // both original and retry 401
        } catch (_: AppErrorException) {
            threw = true
        }
        assertTrue(threw)
        assertTrue(loggedOut)
        assertNull(store.getToken())
    }

    @Test
    fun `non-401 errors propagate without refresh or logout`() = runTest {
        val store = InMemorySessionStore().apply { setSession("t0", "r0") }
        var refreshes = 0
        var loggedOut = false
        val auth = AuthInterceptor(store, { refreshes++; tokenResponse("t1", "r1") }, onLogout = { loggedOut = true })

        try {
            auth.execute { throw AppErrorException(AppError.Server("BOOM", null)) }
        } catch (_: AppErrorException) { /* expected */ }

        assertEquals(0, refreshes)
        assertFalse(loggedOut)
    }

    @Test
    fun `concurrent 401s coalesce onto a single refresh`() = runTest {
        val store = InMemorySessionStore().apply { setSession("t0", "r0") }
        var refreshes = 0
        val gate = CompletableDeferred<Unit>()
        val auth = AuthInterceptor(
            store,
            refreshFn = {
                refreshes++
                gate.await() // hold both callers in refreshOnce simultaneously
                tokenResponse("t1", "r1")
            },
            onLogout = {},
        )

        val send: suspend (String?) -> String = { token ->
            if (token == "t0") throw unauthorized() else "ok:$token"
        }

        val a = async { auth.execute(send) }
        val b = async { auth.execute(send) }
        // let both reach the awaiting refresh (both suspended), then release
        testScheduler.advanceUntilIdle()
        gate.complete(Unit)

        assertEquals("ok:t1", a.await())
        assertEquals("ok:t1", b.await())
        assertEquals(1, refreshes) // coalesced
    }
}
