import 'package:flutter/foundation.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import '../config.dart';

/// Reads the WebView's own `dub_session` cookie for the API-gateway origin.
///
/// `mo3-mobile-bff`'s `POST/GET/DELETE /m/v1/devices` accepts this cookie
/// directly as an alternative to a mobile Bearer token — see
/// `apps/mo3-mobile-bff/src/app.ts` `cookieSession()`, added specifically for
/// the de1 WebView track (which has no separate mobile login/token-exchange
/// step; it only ever holds the web session cookie the WebView already
/// carries on every `/api/v1/` call after login).
///
/// Returns null before login, or if the cookie cannot be read on this
/// platform/WebView state — callers should treat that as "defer and retry",
/// not as an error.
Future<String?> readDubSessionCookie() async {
  try {
    final cookie = await CookieManager.instance().getCookie(
      url: WebUri(AppConfig.apiBaseUrl),
      name: 'dub_session',
    );
    final value = cookie?.value?.toString();
    return (value == null || value.isEmpty) ? null : value;
  } catch (e) {
    debugPrint('[push] could not read dub_session cookie: $e');
    return null;
  }
}
