// NetworkModule — assembles OkHttp + Retrofit + the kotlinx.serialization
// converter, wires the bearer interceptor, and builds the MobileBffClient. Base
// URL carries MO3_BASE_URL + MOBILE_API_PREFIX ("/m/v1/"). The Authorization
// header is redacted from logs (§6 機密).
package jp.developershub.dub.mo2.core.network

import jp.developershub.dub.mo2.core.common.MoConfig
import jp.developershub.dub.mo2.core.common.SessionStore
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import com.jakewharton.retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.Retrofit
import java.util.concurrent.TimeUnit

object NetworkModule {
    val json: Json = Json {
        ignoreUnknownKeys = true // forward-compatible with MO3 additions
        explicitNulls = false // omit null optionals from PATCH bodies (D4 partial update)
        encodeDefaults = false
    }

    fun okHttpClient(store: SessionStore, enableLogging: Boolean): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .addInterceptor(AuthTokenInterceptor(store))
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
        if (enableLogging) {
            val logging = HttpLoggingInterceptor().apply {
                level = HttpLoggingInterceptor.Level.BASIC
                redactHeader("Authorization") // never log the session token
            }
            builder.addInterceptor(logging)
        }
        return builder.build()
    }

    fun retrofit(client: OkHttpClient): Retrofit {
        val contentType = "application/json".toMediaType()
        return Retrofit.Builder()
            .baseUrl(MoConfig.MO3_BASE_URL + MoConfig.MOBILE_API_PREFIX + "/")
            .client(client)
            .addConverterFactory(json.asConverterFactory(contentType))
            .build()
    }

    fun api(retrofit: Retrofit): MobileBffApi = retrofit.create(MobileBffApi::class.java)

    /** Build the production client end-to-end. */
    fun client(store: SessionStore, onLogout: () -> Unit, enableLogging: Boolean): MobileBffClient {
        val api = api(retrofit(okHttpClient(store, enableLogging)))
        return RetrofitMobileBffClient(api, store, onLogout)
    }
}
