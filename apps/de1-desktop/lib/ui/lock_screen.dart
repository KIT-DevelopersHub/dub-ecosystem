import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/app_lock.dart';

/// Full-screen gate shown before the WebView when the biometric launch gate is
/// armed. It stays up until the OS authentication succeeds; only then is the web
/// app revealed and the saved credentials auto-filled.
class LockScreen extends ConsumerWidget {
  const LockScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lock = ref.watch(appLockControllerProvider);
    final theme = Theme.of(context);
    final busy = lock.phase == LockPhase.authenticating;

    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 64,
                  height: 64,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primaryContainer,
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: Icon(
                    Icons.lock_outline,
                    size: 32,
                    color: theme.colorScheme.onPrimaryContainer,
                  ),
                ),
                const SizedBox(height: 20),
                Text('Dub はロックされています',
                    style: theme.textTheme.titleLarge,
                    textAlign: TextAlign.center),
                const SizedBox(height: 8),
                Text(
                  _hint(),
                  style: theme.textTheme.bodyMedium
                      ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 24),
                if (busy)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 8),
                    child: CircularProgressIndicator(),
                  )
                else
                  FilledButton.icon(
                    onPressed: () => ref
                        .read(appLockControllerProvider.notifier)
                        .authenticate(),
                    icon: const Icon(Icons.fingerprint),
                    label: const Text('本人確認して開く'),
                  ),
                if (lock.error != null) ...[
                  const SizedBox(height: 16),
                  Text(
                    lock.error!,
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.error),
                    textAlign: TextAlign.center,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// Platform-appropriate hint for which credential the OS will ask for.
  static String _hint() {
    if (kIsWeb) return '本人確認が必要です';
    if (Platform.isMacOS) {
      return 'Touch ID またはパスワードで本人確認してください';
    }
    if (Platform.isWindows) {
      return 'Windows Hello（顔・指紋・PIN）で本人確認してください';
    }
    if (Platform.isIOS) {
      return 'Face ID / Touch ID またはパスコードで本人確認してください';
    }
    if (Platform.isAndroid) {
      return '指紋・顔認証またはパスコードで本人確認してください';
    }
    return '本人確認が必要です';
  }
}
