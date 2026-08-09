// ErrorMapper — @dub/errors envelope -> AppError (§6). 1:1 port of errors.ts.
// Open-ended: 5xx, 404/412/413 and any unknown code -> Server.
package jp.developershub.dub.mo2.core.network

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.intOrNull
import java.io.IOException

object ErrorMapper {
    private val json = Json { ignoreUnknownKeys = true }

    /** Parse a raw error body string into the @dub/errors envelope, or null. */
    fun parseEnvelope(body: String?): ErrorBody? {
        if (body.isNullOrBlank()) return null
        return try {
            json.decodeFromString(ErrorEnvelope.serializer(), body).error
        } catch (_: Exception) {
            null
        }
    }

    /** Map an HTTP status + (optional) parsed envelope + Retry-After header to AppError. */
    fun mapHttpError(
        status: Int,
        envelope: ErrorBody?,
        retryAfterHeader: String? = null,
    ): AppError {
        val code = envelope?.code ?: "UNKNOWN"
        val requestId = envelope?.requestId
        return when (status) {
            401 -> AppError.Unauthorized(reAuth = true)
            403 -> AppError.Forbidden(code)
            400 -> AppError.Validation(extractFields(envelope?.details))
            409 -> AppError.Conflict(serverVersionFromDetails(envelope?.details))
            429 -> {
                val fromHeader = retryAfterHeader?.toIntOrNull()
                val retryAfterSec = retryAfterFromDetails(envelope?.details)
                    ?: (if (fromHeader != null && fromHeader > 0) fromHeader else 1)
                AppError.RateLimited(retryAfterSec)
            }
            // 5xx, 404/412/413, and any unknown code -> Server (open-ended, §6).
            else -> AppError.Server(code, requestId)
        }
    }

    /** Map a transport failure (offline / timeout / DNS) to AppError.Network. */
    fun mapNetworkError(cause: Throwable): AppError {
        val retryable = cause is IOException
        return AppError.Network(retryable)
    }

    private fun extractFields(details: JsonElement?): Map<String, String> {
        val arr = details as? JsonArray ?: return emptyMap()
        val out = LinkedHashMap<String, String>()
        for (el in arr) {
            val obj = el as? JsonObject ?: continue
            val field = obj["field"]?.jsonPrimitive?.contentOrNull ?: continue
            val message = obj["message"]?.jsonPrimitive?.contentOrNull
            val reason = obj["reason"]?.jsonPrimitive?.contentOrNull
            out[field] = message ?: reason ?: "invalid"
        }
        return out
    }

    private fun retryAfterFromDetails(details: JsonElement?): Int? {
        val obj = details as? JsonObject ?: return null
        return obj["retryAfterSec"]?.jsonPrimitive?.floatOrNull?.toInt()
    }

    private fun serverVersionFromDetails(details: JsonElement?): Int? {
        val obj = details as? JsonObject ?: return null
        for (k in listOf("serverVersion", "version", "currentVersion")) {
            val v = obj[k]?.jsonPrimitive?.intOrNull
            if (v != null) return v
        }
        return null
    }
}
