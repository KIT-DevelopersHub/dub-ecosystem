// MainActivity — single-activity Compose host. Sets the DubTheme and the
// NavHost, which owns App Links / dub:// deep-link routing. Intent deep links are
// handled by Navigation Compose's navDeepLink patterns declared per destination.
package jp.developershub.dub.mo2

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import jp.developershub.dub.mo2.navigation.DubNavHost
import jp.developershub.dub.mo2.ui.theme.DubTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as DubApp).container
        setContent {
            DubTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    DubNavHost(container = container)
                }
            }
        }
    }
}
