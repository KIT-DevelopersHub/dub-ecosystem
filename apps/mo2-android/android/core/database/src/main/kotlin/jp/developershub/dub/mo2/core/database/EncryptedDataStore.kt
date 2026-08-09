// EncryptedDataStore — the Android SessionStore impl (§3). Backs the single
// opaque session token, mobile refresh token, and server deviceId with
// AndroidX EncryptedSharedPreferences (AES-256, Android Keystore master key).
// Secrets never leave the vault and are never logged (§6 機密).
package jp.developershub.dub.mo2.core.database

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import jp.developershub.dub.mo2.core.common.SessionStore

class EncryptedDataStore(
    private val prefs: SharedPreferences,
) : SessionStore {

    override fun getToken(): String? = prefs.getString(KEY_TOKEN, null)
    override fun getRefreshToken(): String? = prefs.getString(KEY_REFRESH, null)
    override fun getDeviceId(): String? = prefs.getString(KEY_DEVICE, null)

    override fun setSession(token: String, refreshToken: String?) {
        prefs.edit().apply {
            putString(KEY_TOKEN, token)
            if (refreshToken != null) putString(KEY_REFRESH, refreshToken) else remove(KEY_REFRESH)
        }.apply()
    }

    override fun setDeviceId(deviceId: String) {
        prefs.edit().putString(KEY_DEVICE, deviceId).apply()
    }

    override fun clear() {
        // deviceId survives logout (server ULID; §3) — only auth material is wiped.
        prefs.edit().remove(KEY_TOKEN).remove(KEY_REFRESH).apply()
    }

    companion object {
        private const val FILE = "dub_mo2_session_vault"
        private const val KEY_TOKEN = "session_token"
        private const val KEY_REFRESH = "refresh_token"
        private const val KEY_DEVICE = "device_id"

        /** Build the Keystore-backed encrypted vault. */
        fun create(context: Context): EncryptedDataStore {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val prefs = EncryptedSharedPreferences.create(
                context,
                FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            return EncryptedDataStore(prefs)
        }
    }
}
