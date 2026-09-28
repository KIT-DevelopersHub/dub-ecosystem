import Cocoa
import FlutterMacOS
import FirebaseMessaging

@main
class AppDelegate: FlutterAppDelegate {
  // Native<->Dart push channel (see lib/push/native_push.dart). macOS registers
  // for APNs and hands the raw device token back to Dart, which POSTs it to
  // mo3-mobile-bff (platform "macos"); the server's APNs adapter uses the macOS
  // apns-topic (APNS_MACOS_BUNDLE_ID) to deliver.
  private var pushChannel: FlutterMethodChannel?
  private var pendingResult: FlutterResult?

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }

  override func applicationDidFinishLaunching(_ notification: Notification) {
    if let controller = NSApp.mainWindow?.contentViewController as? FlutterViewController {
      let channel = FlutterMethodChannel(
        name: "jp.developershub.dub/native_push",
        binaryMessenger: controller.engine.binaryMessenger)
      channel.setMethodCallHandler { [weak self] call, result in
        switch call.method {
        case "registerForPush":
          self?.pendingResult = result
          DispatchQueue.main.async { NSApplication.shared.registerForRemoteNotifications() }
        default:
          result(FlutterMethodNotImplemented)
        }
      }
      pushChannel = channel
    }
    super.applicationDidFinishLaunching(notification)
  }

  override func application(
    _ application: NSApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    // Bridge the raw APNs token to FirebaseMessaging explicitly: this
    // AppDelegate owns `didRegisterForRemoteNotificationsWithDeviceToken`
    // itself (does not call `super`), which would otherwise starve
    // `firebase_messaging`'s `getToken()` on macOS of the APNs token it needs
    // before it can mint an FCM registration token (see lib/push/fcm_push.dart,
    // now enabled on macOS for push-notification testing).
    Messaging.messaging().apnsToken = deviceToken

    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    pendingResult?(token)
    pendingResult = nil
    pushChannel?.invokeMethod("onPushToken", arguments: ["token": token])
  }

  override func application(
    _ application: NSApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    pendingResult?(FlutterError(
      code: "apns_registration_failed",
      message: error.localizedDescription,
      details: nil))
    pendingResult = nil
  }
}
