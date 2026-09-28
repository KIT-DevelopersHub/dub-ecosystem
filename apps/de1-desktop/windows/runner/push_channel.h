#ifndef RUNNER_PUSH_CHANNEL_H_
#define RUNNER_PUSH_CHANNEL_H_

#include <flutter/flutter_engine.h>

namespace dub {

// Registers the "jp.developershub.dub/native_push" MethodChannel on |engine|.
// It implements `registerForPush`, which creates (or refreshes) the app's WNS
// Channel URI via PushNotificationChannelManager and returns it to Dart, which
// POSTs it to mo3-mobile-bff (platform "windows"). See lib/push/native_push.dart.
//
// NOTE: WNS channel creation requires the app to run with package identity
// (MSIX / sparse package). An unpackaged run returns a WNS error, which Dart
// treats as "remote push unavailable" (foreground notifications keep working).
void RegisterPushChannel(flutter::FlutterEngine* engine);

}  // namespace dub

#endif  // RUNNER_PUSH_CHANNEL_H_
