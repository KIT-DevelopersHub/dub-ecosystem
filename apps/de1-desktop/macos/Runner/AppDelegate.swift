import Cocoa
import FirebaseMessaging
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  // Native<->Dart push channel (see lib/push/native_push.dart). macOS registers
  // for APNs and hands the raw device token back to Dart. The FCM token that
  // mo3 actually sends to is minted by firebase_messaging (lib/push/fcm_push.dart).
  //
  // Do NOT call `super` from the overrides below: FlutterAppDelegate (macOS)
  // implements none of them, so `super` throws "unrecognized selector". In
  // `applicationDidFinishLaunching` that exception aborts the launch
  // notification before firebase_messaging's observer runs, which skips its
  // app-delegate swizzling — the plugin then never receives the APNs token and
  // `getToken()` never returns. The APNs token is handed to FCM explicitly in
  // `didRegisterForRemoteNotificationsWithDeviceToken` (as on iOS).
  private var pushChannel: FlutterMethodChannel?
  private var pendingResult: FlutterResult?

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }

  override func applicationDidFinishLaunching(_ notification: Notification) {
    // `NSApp.mainWindow` is still nil here (the window is not key yet); use
    // the nib outlet so the channel is actually wired.
    guard let controller = mainFlutterWindow?.contentViewController as? FlutterViewController
    else { return }
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

  override func application(
    _ application: NSApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    // Same as iOS: hand the APNs token to FCM explicitly. Without this the FCM
    // token is not bound to this Mac's APNs token and sends are accepted (200)
    // but never delivered.
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
