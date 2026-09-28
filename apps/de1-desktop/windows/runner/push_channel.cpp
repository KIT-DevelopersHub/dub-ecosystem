#include "push_channel.h"

#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>
#include <windows.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Networking.PushNotifications.h>

#include <memory>
#include <string>
#include <thread>

using flutter::EncodableValue;
using flutter::MethodCall;
using flutter::MethodResult;

namespace {

constexpr char kChannelName[] = "jp.developershub.dub/native_push";

std::string Utf8FromWide(const std::wstring& w) {
  if (w.empty()) return std::string();
  int len = ::WideCharToMultiByte(CP_UTF8, 0, w.c_str(),
                                  static_cast<int>(w.size()), nullptr, 0,
                                  nullptr, nullptr);
  std::string out(static_cast<size_t>(len), '\0');
  ::WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()),
                        out.data(), len, nullptr, nullptr);
  return out;
}

// Runs on a detached worker thread: creating a WNS channel is async and must not
// block the platform thread. The MethodResult is moved into a shared_ptr so it
// can be completed from here.
void CreateWnsChannel(std::shared_ptr<MethodResult<EncodableValue>> result) {
  try {
    winrt::init_apartment();
    using winrt::Windows::Networking::PushNotifications::
        PushNotificationChannelManager;
    auto op = PushNotificationChannelManager::
        CreatePushNotificationChannelForApplicationAsync();
    auto channel = op.get();  // blocks this worker thread only
    std::wstring uri{channel.Uri().c_str()};
    result->Success(EncodableValue(Utf8FromWide(uri)));
  } catch (const winrt::hresult_error& e) {
    result->Error("wns_channel_failed", Utf8FromWide(std::wstring{e.message()}));
  } catch (...) {
    result->Error("wns_channel_failed", "unknown error creating WNS channel");
  }
}

}  // namespace

namespace dub {

void RegisterPushChannel(flutter::FlutterEngine* engine) {
  // Kept alive for the process lifetime (the engine outlives this call).
  static std::shared_ptr<flutter::MethodChannel<EncodableValue>> channel;
  channel = std::make_shared<flutter::MethodChannel<EncodableValue>>(
      engine->messenger(), kChannelName,
      &flutter::StandardMethodCodec::GetInstance());

  channel->SetMethodCallHandler(
      [](const MethodCall<EncodableValue>& call,
         std::unique_ptr<MethodResult<EncodableValue>> result) {
        if (call.method_name() == "registerForPush") {
          std::shared_ptr<MethodResult<EncodableValue>> shared{std::move(result)};
          std::thread(CreateWnsChannel, shared).detach();
        } else {
          result->NotImplemented();
        }
      });
}

}  // namespace dub
