// AuthTokenInterceptor — attaches `Authorization: Bearer <token>` from the
// SessionStore at request time. Because the header is read per-request, an
// AuthInterceptor refresh that rotates the stored token is automatically picked
// up on the retried call. The token is never logged (§6 機密).
package jp.developershub.dub.mo2.core.network

import jp.developershub.dub.mo2.core.common.SessionStore
import okhttp3.Interceptor
import okhttp3.Response

class AuthTokenInterceptor(
    private val store: SessionStore,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val token = store.getToken()
        val request = if (token != null) {
            chain.request().newBuilder()
                .header("Authorization", "Bearer $token")
                .header("Accept", "application/json")
                .build()
        } else {
            chain.request().newBuilder().header("Accept", "application/json").build()
        }
        return chain.proceed(request)
    }
}
