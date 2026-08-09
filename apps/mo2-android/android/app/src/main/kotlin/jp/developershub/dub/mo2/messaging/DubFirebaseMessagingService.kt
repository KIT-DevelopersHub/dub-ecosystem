// DubFirebaseMessagingService — FCM entry point (STUB, §2-3 / §8). Receives the
// rotated registration token and incoming data messages, parses them via
// parsePush, and would post a notification whose tap deep-links via tapRoute.
// This is a scaffold stub: it has no google-services.json wired (that is a
// per-environment step) and does not yet register the token with MO3
// (registerDevice) or build the system notification — those land with the DI
// graph + notification-channel wave. Kept minimal and side-effect-free so it
// compiles and documents the contract.
package jp.developershub.dub.mo2.messaging

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class DubFirebaseMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        // STUB: hand the rotated token to MO3 via MobileBffClient.registerDevice()
        // once the app DI graph exposes it here. Never log the token itself.
        Log.d(TAG, "FCM token refreshed (len=${token.length})")
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val parsed = parsePush(
            title = message.notification?.title,
            body = message.notification?.body,
            data = message.data,
        )
        // STUB: build a system notification whose contentIntent deep-links to
        // parsed.tapRoute and apply parsed.badge. Wired in the notification wave.
        Log.d(TAG, "push received -> route=${parsed.tapRoute}")
    }

    private companion object {
        const val TAG = "DubFcm"
    }
}
