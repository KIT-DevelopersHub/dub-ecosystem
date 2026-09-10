import 'package:flutter/widgets.dart';

import 'config.dart';

/// The ecosystem's launchable features (mirrors the web 9-dot launcher).
///
/// Each maps to a route inside the Web SPA. This enum is the vocabulary the
/// [FeatureRegistry] uses to decide, per feature, whether the desktop app shows
/// the web page or a native Flutter implementation.
enum DubFeature {
  notifications('/notifications'),
  chat('/chat'),
  tasks('/tasks'),
  gantt('/gantt'),
  mail('/mail'),
  events('/events'),
  roster('/roster'),
  drive('/drive'),
  settings('/settings');

  const DubFeature(this.webPath);

  /// Path of this feature inside the Web SPA (used both to open the right web
  /// route and, later, to intercept navigation when a native view takes over).
  final String webPath;
}

/// Builds a native Flutter view for a feature (used once a feature is ported).
typedef NativeFeatureBuilder = Widget Function(BuildContext context);

/// The single seam for **incremental native-ization**.
///
/// Right now the desktop app is a 完コピ (perfect copy) of the web app: the whole
/// window is one WebView and *every* feature is served by the web bundle, so this
/// registry has **no** native builders and [entryUrl] returns the web app root.
///
/// Later, to move one screen at a time off the web and onto native Flutter:
///
///   1. Implement the screen as a widget and register it here:
///        `FeatureRegistry.registerNative(DubFeature.tasks, (ctx) => TasksView());`
///   2. The shell can then render that widget instead of the WebView for that
///      feature (e.g. by intercepting web navigation to `feature.webPath` and
///      swapping in `nativeBuilder(feature)`), while every unregistered feature
///      keeps rendering the web page untouched.
///
/// Nothing else in the app needs to know which features are native — this map is
/// the whole switch. See `docs/desktop-flutter/ARCHITECTURE.md` ("漸進的ネイティブ化").
class FeatureRegistry {
  FeatureRegistry._();

  static final Map<DubFeature, NativeFeatureBuilder> _natives = {};

  /// Register a native implementation for [feature]. Idempotent per feature.
  static void registerNative(DubFeature feature, NativeFeatureBuilder builder) {
    _natives[feature] = builder;
  }

  /// True once [feature] has a native implementation registered.
  static bool hasNative(DubFeature feature) => _natives.containsKey(feature);

  /// The native builder for [feature], or null if it is still served by the web.
  static NativeFeatureBuilder? nativeBuilder(DubFeature feature) =>
      _natives[feature];

  /// Whether *any* feature is native yet (false today → pure 完コピ mode).
  static bool get hasAnyNative => _natives.isNotEmpty;

  /// The URL the shell's WebView should open on launch — the web app root, so
  /// the SPA's own login and 9-dot launcher drive navigation exactly as on web.
  static String entryUrl() => AppConfig.webBaseUrl;
}
