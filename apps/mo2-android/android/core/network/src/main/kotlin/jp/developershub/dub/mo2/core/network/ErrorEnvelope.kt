// Mirror of @dub/errors `ErrorResponse` wire form (packages/errors/src/wire.ts) —
// the single error envelope all services/gateway/MO3 emit (theme3 D7). `details`
// is open (validation FieldError[], RateLimitDetails, conflict version, ...) so
// it is decoded as a raw JsonElement and interpreted by ErrorMapper.
package jp.developershub.dub.mo2.core.network

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class ErrorEnvelope(
    val error: ErrorBody,
)

@Serializable
data class ErrorBody(
    val code: String,
    val message: String,
    val details: JsonElement? = null,
    val requestId: String? = null,
    val service: String? = null,
    val retryable: Boolean = false,
)

@Serializable
data class FieldError(
    val field: String,
    val reason: String,
    val message: String? = null,
)
