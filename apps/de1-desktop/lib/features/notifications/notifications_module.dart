import 'package:flutter/material.dart';

import '../../core/feature_module.dart';
import 'notifications_view.dart';

/// Notifications feature registration. The reference implementation of the
/// module pattern (see FEATURE_MODULE_GUIDE.md).
class NotificationsModule extends FeatureModule {
  const NotificationsModule();

  @override
  String get id => 'notifications';

  @override
  String get label => '通知';

  @override
  IconData get icon => Icons.notifications_outlined;

  @override
  Widget buildView(BuildContext context) => const NotificationsView();
}
