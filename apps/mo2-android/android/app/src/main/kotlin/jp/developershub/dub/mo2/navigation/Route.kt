// Deep-link resolver (§2-4). App Links (https://developershub.jp/...) is
// canonical; the custom scheme dub:// is the fallback (devhub:// retired). Same
// route table the NavHost consumes. 1:1 port of deep-link.ts.
package jp.developershub.dub.mo2.navigation

import jp.developershub.dub.mo2.core.common.MoConfig
import java.net.URI

sealed interface Route {
    data object Home : Route // S2
    data class EventDetail(val eventId: String) : Route // S4
    data class TaskDetail(val taskId: String) : Route // S6
    data object Inbox : Route // S7
    data class Unknown(val raw: String) : Route
}

/** Parse an App Link or dub:// fallback into a Route. Unknown -> Route.Unknown. */
fun parseDeepLink(raw: String): Route {
    val segments: List<String> = try {
        val uri = URI(raw)
        when (uri.scheme?.lowercase()) {
            "https" -> {
                if (uri.host != MoConfig.APP_LINK_HOST) return Route.Unknown(raw)
                splitPath(uri.path)
            }
            MoConfig.DEEP_LINK_SCHEME -> {
                // dub://events/{id} -> host="events", path="/{id}"
                (listOf(uri.host).filterNotNull() + splitPath(uri.path)).filter { it.isNotEmpty() }
            }
            else -> return Route.Unknown(raw)
        }
    } catch (_: Exception) {
        return Route.Unknown(raw)
    }

    val head = segments.getOrNull(0)
    val id = segments.getOrNull(1)
    return when (head) {
        "home" -> Route.Home
        "inbox" -> Route.Inbox
        "events" -> if (id != null) Route.EventDetail(id) else Route.Unknown(raw)
        "tasks" -> if (id != null) Route.TaskDetail(id) else Route.Unknown(raw)
        else -> Route.Unknown(raw)
    }
}

private fun splitPath(path: String?): List<String> =
    path.orEmpty().split("/").filter { it.isNotEmpty() }
