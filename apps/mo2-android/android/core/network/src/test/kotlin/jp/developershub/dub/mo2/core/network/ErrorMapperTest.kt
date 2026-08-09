// ErrorMapper unit tests (§7) — status -> AppError branches, @dub/errors
// envelope parsing (fields / retryAfter / serverVersion), Retry-After header
// fallback, and open-ended fallthrough to Server. Mirrors errors.test.ts.
package jp.developershub.dub.mo2.core.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ErrorMapperTest {

    @Test
    fun `401 maps to Unauthorized reAuth`() {
        val e = ErrorMapper.mapHttpError(401, null)
        assertTrue(e is AppError.Unauthorized && e.reAuth)
        assertTrue(e.isReauthable())
    }

    @Test
    fun `403 carries the code`() {
        val env = ErrorMapper.parseEnvelope("""{"error":{"code":"TASK_FORBIDDEN","message":"no","retryable":false}}""")
        val e = ErrorMapper.mapHttpError(403, env)
        assertEquals(AppError.Forbidden("TASK_FORBIDDEN"), e)
    }

    @Test
    fun `400 extracts field errors, preferring message then reason`() {
        val body = """{"error":{"code":"VALIDATION_FAILED","message":"bad","retryable":false,
            "details":[{"field":"title","reason":"required","message":"Title is required"},
                       {"field":"dueAt","reason":"invalid_date"}]}}"""
        val e = ErrorMapper.mapHttpError(400, ErrorMapper.parseEnvelope(body)) as AppError.Validation
        assertEquals("Title is required", e.fields["title"])
        assertEquals("invalid_date", e.fields["dueAt"])
    }

    @Test
    fun `409 reads serverVersion from details`() {
        val body = """{"error":{"code":"TASK_VERSION_CONFLICT","message":"conflict","retryable":false,"details":{"serverVersion":9}}}"""
        val e = ErrorMapper.mapHttpError(409, ErrorMapper.parseEnvelope(body)) as AppError.Conflict
        assertEquals(9, e.serverVersion)
    }

    @Test
    fun `409 with no version is null`() {
        val e = ErrorMapper.mapHttpError(409, null) as AppError.Conflict
        assertNull(e.serverVersion)
    }

    @Test
    fun `429 prefers details retryAfter, else header, else 1`() {
        val fromDetails = ErrorMapper.mapHttpError(
            429,
            ErrorMapper.parseEnvelope("""{"error":{"code":"RATE_LIMITED","message":"x","retryable":true,"details":{"retryAfterSec":30}}}"""),
        ) as AppError.RateLimited
        assertEquals(30, fromDetails.retryAfterSec)

        val fromHeader = ErrorMapper.mapHttpError(429, null, retryAfterHeader = "12") as AppError.RateLimited
        assertEquals(12, fromHeader.retryAfterSec)

        val fallback = ErrorMapper.mapHttpError(429, null) as AppError.RateLimited
        assertEquals(1, fallback.retryAfterSec)
    }

    @Test
    fun `5xx and unknown status fall through to Server with requestId`() {
        val body = """{"error":{"code":"INTERNAL","message":"boom","retryable":false,"requestId":"req_123"}}"""
        val e = ErrorMapper.mapHttpError(500, ErrorMapper.parseEnvelope(body)) as AppError.Server
        assertEquals("INTERNAL", e.code)
        assertEquals("req_123", e.requestId)

        val unknown = ErrorMapper.mapHttpError(418, null) as AppError.Server
        assertEquals("UNKNOWN", unknown.code)
    }

    @Test
    fun `malformed body parses to null envelope`() {
        assertNull(ErrorMapper.parseEnvelope("not json"))
        assertNull(ErrorMapper.parseEnvelope(""))
        assertNull(ErrorMapper.parseEnvelope("""{"nope":true}"""))
    }

    @Test
    fun `network errors from IO are retryable`() {
        val e = ErrorMapper.mapNetworkError(java.io.IOException("offline")) as AppError.Network
        assertTrue(e.retryable)
    }
}
