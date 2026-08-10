// AppContainer — manual DI graph (no Hilt/KSP; a scaffold keeps wiring explicit
// and testable). Owns the process-wide singletons: the EncryptedDataStore
// session vault, the MobileBffClient (MO3-only), and the TaskRepository. onLogout
// flips a StateFlow the app shell observes to route back to S1.
package jp.developershub.dub.mo2.di

import android.content.Context
import jp.developershub.dub.mo2.BuildConfig
import jp.developershub.dub.mo2.core.common.SessionStore
import jp.developershub.dub.mo2.core.database.EncryptedDataStore
import jp.developershub.dub.mo2.core.network.MobileBffClient
import jp.developershub.dub.mo2.core.network.NetworkModule
import jp.developershub.dub.mo2.feature.chat.ChatRepository
import jp.developershub.dub.mo2.feature.tasks.TaskRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class AppContainer(context: Context) {

    private val _loggedOut = MutableStateFlow(false)
    /** Emits true when the session was cleared (interceptor gave up) -> go to S1. */
    val loggedOut: StateFlow<Boolean> = _loggedOut.asStateFlow()

    val sessionStore: SessionStore = EncryptedDataStore.create(context.applicationContext)

    val bffClient: MobileBffClient = NetworkModule.client(
        store = sessionStore,
        onLogout = { _loggedOut.value = true },
        enableLogging = BuildConfig.DEBUG,
    )

    val taskRepository: TaskRepository = TaskRepository(bffClient)

    /**
     * Chat repository (S10). The realtime transport is left null here: the OkHttp
     * WebSocket transport (DO-direct, minted via getChatWsTicket) is wired in the
     * chat wave; until then the repo works pull-only (optimistic send + refresh),
     * and connectRealtime is a no-op.
     */
    val chatRepository: ChatRepository = ChatRepository(bffClient, transport = null)

    /**
     * Current user id for optimistic chat authorship. The BFF attributes the author
     * server-side from the bearer, so this is only the cosmetic id shown on a pending
     * row until the POST ack promotes it. Resolved from the session in the auth wave.
     */
    val currentUserId: String = "me"

    fun acknowledgeLogout() {
        _loggedOut.value = false
    }
}
