// Push parser unit tests (§2-3, test #5) — build MobilePushPayload from the FCM
// notification block + data map, resolve the tap route from data.deepLink, and
// read notificationId / badge. Mirrors push.test.ts.
package jp.developershub.dub.mo2

import jp.developershub.dub.mo2.messaging.parsePush
import jp.developershub.dub.mo2.navigation.Route
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PushParserTest {

    @Test
    fun `resolves tap route, notification id and badge from data`() {
        val parsed = parsePush(
            title = "New task",
            body = "Assigned to you",
            data = mapOf(
                "deepLink" to "dub://tasks/tsk_5",
                "notificationId" to "ntf_1",
                "badge" to "3",
            ),
        )
        assertEquals(Route.TaskDetail("tsk_5"), parsed.tapRoute)
        assertEquals("ntf_1", parsed.notificationId)
        assertEquals(3, parsed.badge)
        assertEquals("New task", parsed.payload.title)
        assertEquals("Assigned to you", parsed.payload.body)
    }

    @Test
    fun `notification block title-body take precedence, else data fallback`() {
        val fromBlock = parsePush("BlockTitle", "BlockBody", mapOf("title" to "DataTitle"))
        assertEquals("BlockTitle", fromBlock.payload.title)

        val fromData = parsePush(null, null, mapOf("title" to "DataTitle", "body" to "DataBody"))
        assertEquals("DataTitle", fromData.payload.title)
        assertEquals("DataBody", fromData.payload.body)
    }

    @Test
    fun `empty data yields unknown route and null metadata`() {
        val parsed = parsePush(title = "x", body = "y", data = emptyMap())
        assertTrue(parsed.tapRoute is Route.Unknown)
        assertNull(parsed.notificationId)
        assertNull(parsed.badge)
        assertNull(parsed.payload.data)
    }

    @Test
    fun `non-numeric badge is null`() {
        val parsed = parsePush("x", "y", mapOf("badge" to "lots"))
        assertNull(parsed.badge)
    }

    @Test
    fun `missing title and body default to empty strings`() {
        val parsed = parsePush(null, null, emptyMap())
        assertEquals("", parsed.payload.title)
        assertEquals("", parsed.payload.body)
    }
}
