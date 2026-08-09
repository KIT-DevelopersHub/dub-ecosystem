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

    fun acknowledgeLogout() {
        _loggedOut.value = false
    }
}
