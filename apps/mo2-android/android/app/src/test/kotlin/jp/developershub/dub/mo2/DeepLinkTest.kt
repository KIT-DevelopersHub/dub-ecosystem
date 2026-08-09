// Deep-link parser unit tests (§2-4) — App Links canonical + dub:// fallback,
// wrong host / scheme / missing id / malformed all resolve to Unknown.
// Mirrors deep-link.test.ts.
package jp.developershub.dub.mo2

import jp.developershub.dub.mo2.navigation.Route
import jp.developershub.dub.mo2.navigation.parseDeepLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeepLinkTest {

    @Test
    fun `app link home`() {
        assertEquals(Route.Home, parseDeepLink("https://developershub.jp/home"))
    }

    @Test
    fun `app link task detail`() {
        assertEquals(Route.TaskDetail("tsk_1"), parseDeepLink("https://developershub.jp/tasks/tsk_1"))
    }

    @Test
    fun `app link event detail`() {
        assertEquals(Route.EventDetail("evt_9"), parseDeepLink("https://developershub.jp/events/evt_9"))
    }

    @Test
    fun `app link inbox`() {
        assertEquals(Route.Inbox, parseDeepLink("https://developershub.jp/inbox"))
    }

    @Test
    fun `custom scheme fallback resolves the same routes`() {
        assertEquals(Route.Home, parseDeepLink("dub://home"))
        assertEquals(Route.TaskDetail("tsk_2"), parseDeepLink("dub://tasks/tsk_2"))
        assertEquals(Route.EventDetail("evt_2"), parseDeepLink("dub://events/evt_2"))
        assertEquals(Route.Inbox, parseDeepLink("dub://inbox"))
    }

    @Test
    fun `wrong host is unknown`() {
        assertTrue(parseDeepLink("https://evil.example.com/tasks/1") is Route.Unknown)
    }

    @Test
    fun `retired scheme is unknown`() {
        assertTrue(parseDeepLink("devhub://home") is Route.Unknown)
    }

    @Test
    fun `missing id is unknown`() {
        assertTrue(parseDeepLink("https://developershub.jp/tasks") is Route.Unknown)
        assertTrue(parseDeepLink("dub://events") is Route.Unknown)
    }

    @Test
    fun `unknown head is unknown`() {
        assertTrue(parseDeepLink("https://developershub.jp/settings") is Route.Unknown)
    }

    @Test
    fun `malformed input is unknown`() {
        assertTrue(parseDeepLink("not a url") is Route.Unknown)
        assertTrue(parseDeepLink("") is Route.Unknown)
    }
}
