import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  // Native<->Dart push channel (see lib/push/native_push.dart). iOS registers
  // for APNs here and hands the raw device token back to Dart, which POSTs it to
  // mo3-mobile-bff (platform "ios"); the server's APNs adapter sends to it.
  private var pushChannel: FlutterMethodChannel?
  private var pendingResult: FlutterResult?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)

    if let controller = window?.rootViewController as? FlutterViewController {
      let channel = FlutterMethodChannel(
        name: "jp.developershub.dub/native_push",
        binaryMessenger: controller.binaryMessenger)
      channel.setMethodCallHandler { [weak self] call, result in
        switch call.method {
        case "registerForPush":
          // The notification permission prompt is owned by
          // flutter_local_notifications (Dart requestPermission); here we only
          // ask the OS to mint an APNs device token.
          self?.pendingResult = result
          DispatchQueue.main.async { application.registerForRemoteNotifications() }
        default:
          result(FlutterMethodNotImplemented)
        }
      }
      pushChannel = channel
    }

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    pendingResult?(token)
    pendingResult = nil
    // Also push refreshes proactively (token can change across reinstalls/restores).
    pushChannel?.invokeMethod("onPushToken", arguments: ["token": token])
    super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
  }

  override func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    pendingResult?(FlutterError(
      code: "apns_registration_failed",
      message: error.localizedDescription,
      details: nil))
    pendingResult = nil
    super.application(application, didFailToRegisterForRemoteNotificationsWithError: error)
  }
}
