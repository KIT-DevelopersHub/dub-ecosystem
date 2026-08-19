import 'package:flutter/material.dart';

import '../../core/feature_module.dart';
import 'chat_view.dart';

/// Chat feature registration. Realtime via the ChatRoom Durable Object
/// (ADR-0002); HTTP via `/api/v1/chat/*`.
class ChatModule extends FeatureModule {
  const ChatModule();

  @override
  String get id => 'chat';

  @override
  String get label => 'チャット';

  @override
  IconData get icon => Icons.chat_bubble_outline;

  @override
  Widget buildView(BuildContext context) => const ChatView();
}
