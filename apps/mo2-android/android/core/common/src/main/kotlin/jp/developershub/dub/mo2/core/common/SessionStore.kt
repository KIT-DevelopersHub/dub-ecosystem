// SessionStore — client-side secret vault contract (mirror of session-store.ts).
// Holds a single opaque session token (theme8, no 2-token/JWT), the mobile
// refresh token, and the server-issued deviceId ULID. Never logged. The Android
// impl is EncryptedDataStore (core:database); InMemorySessionStore backs tests.
package jp.developershub.dub.mo2.core.common

interface SessionStore {
    fun getToken(): String?
    fun getRefreshToken(): String?
    fun getDeviceId(): String?
    fun setSession(token: String, refreshToken: String?)
    fun setDeviceId(deviceId: String)
    fun clear() // logout
}

/** In-memory impl for unit tests (and previews). Mirrors InMemorySessionStore. */
class InMemorySessionStore : SessionStore {
    private var token: String? = null
    private var refreshToken: String? = null
    private var deviceId: String? = null

    override fun getToken(): String? = token
    override fun getRefreshToken(): String? = refreshToken
    override fun getDeviceId(): String? = deviceId

    override fun setSession(token: String, refreshToken: String?) {
        this.token = token
        this.refreshToken = refreshToken
    }

    override fun setDeviceId(deviceId: String) {
        this.deviceId = deviceId
    }

    override fun clear() {
        token = null
        refreshToken = null
        // deviceId is kept — it survives logout (server ULID; §3).
    }
}
