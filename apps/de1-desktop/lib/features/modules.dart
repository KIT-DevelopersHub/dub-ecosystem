import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/feature_module.dart';
import 'chat/chat_module.dart';
import 'notifications/notifications_module.dart';

/// THE feature registry — the single shared file a new feature touches.
///
/// To add a feature:
///   1. Create `lib/features/<feature>/` with a `<Feature>Module`.
///   2. Add its import above.
///   3. Add one line to [kFeatureModules] below.
/// Nothing else in the shell changes. Order here = launcher order.
///
/// A [ComingSoonModule] entry is a placeholder for an unbuilt feature; the
/// owning agent replaces that one line with their real module import + entry.
const List<FeatureModule> kFeatureModules = <FeatureModule>[
  NotificationsModule(),
  ChatModule(),
  ComingSoonModule(
      id: 'tasks', label: 'タスク', icon: Icons.check_circle_outline),
  ComingSoonModule(id: 'gantt', label: 'ガント', icon: Icons.timeline),
  ComingSoonModule(id: 'mail', label: 'メール', icon: Icons.mail_outline),
  ComingSoonModule(id: 'events', label: 'イベント', icon: Icons.event_outlined),
  ComingSoonModule(id: 'roster', label: '名簿', icon: Icons.groups_outlined),
  ComingSoonModule(id: 'drive', label: 'ドライブ', icon: Icons.folder_outlined),
];

/// The registered feature modules (launcher order).
final featureModulesProvider =
    Provider<List<FeatureModule>>((_) => kFeatureModules);

/// The feature selected on launch (first registered module).
final String defaultFeatureId = kFeatureModules.first.id;
