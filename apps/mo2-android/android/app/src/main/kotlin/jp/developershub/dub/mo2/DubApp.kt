// DubApp — Application holding the process-wide AppContainer (manual DI root).
package jp.developershub.dub.mo2

import android.app.Application
import jp.developershub.dub.mo2.di.AppContainer

class DubApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
