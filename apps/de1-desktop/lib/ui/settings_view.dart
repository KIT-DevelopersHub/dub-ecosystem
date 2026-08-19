import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../state/auth.dart';
import 'shared.dart';

/// Settings app: the signed-in user's profile (from `/api/v1/me`) plus a
/// password-change entry point (Web #316 parity, `POST /api/v1/me/password`).
class SettingsView extends ConsumerWidget {
  const SettingsView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(authControllerProvider).me;
    final theme = Theme.of(context);

    if (me == null) {
      return const Center(child: CircularProgressIndicator());
    }

    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
      children: [
        Text('設定', style: theme.textTheme.headlineSmall),
        const SizedBox(height: 20),
        _ProfileCard(me: me),
        const SizedBox(height: 24),
        Text('セキュリティ', style: theme.textTheme.titleMedium),
        const SizedBox(height: 8),
        Card(
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: BorderSide(color: theme.colorScheme.outlineVariant),
          ),
          child: ListTile(
            leading: const Icon(Icons.lock_outline),
            title: const Text('パスワードを変更'),
            subtitle: const Text('現在のパスワードを確認してから新しいパスワードに更新します'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => showDialog<void>(
              context: context,
              builder: (_) => const ChangePasswordDialog(),
            ),
          ),
        ),
      ],
    );
  }
}

class _ProfileCard extends StatelessWidget {
  const _ProfileCard({required this.me});
  final MeResponse me;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final expires = formatWhen(
        DateTime.fromMillisecondsSinceEpoch(me.sessionExpiresAt)
            .toUtc()
            .toIso8601String());
    return Card(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: theme.colorScheme.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 26,
                  backgroundColor: theme.colorScheme.primaryContainer,
                  child: Text(
                    _initial(me.user.displayName),
                    style: theme.textTheme.titleLarge
                        ?.copyWith(color: theme.colorScheme.onPrimaryContainer),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(me.user.displayName,
                          style: theme.textTheme.titleLarge),
                      const SizedBox(height: 2),
                      Text('ユーザーID: ${me.user.id}',
                          style: theme.textTheme.bodySmall
                              ?.copyWith(color: theme.colorScheme.outline)),
                    ],
                  ),
                ),
              ],
            ),
            const Divider(height: 32),
            _InfoRow(label: '組織', value: me.orgId),
            _InfoRow(
              label: '権限',
              value: me.permissions.isEmpty ? '—' : me.permissions.join(', '),
            ),
            if (expires != null) _InfoRow(label: 'セッション有効期限', value: expires),
          ],
        ),
      ),
    );
  }

  static String _initial(String name) =>
      name.isEmpty ? '?' : name.characters.first.toUpperCase();
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(label,
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: theme.colorScheme.outline)),
          ),
          Expanded(
            child: Text(value, style: theme.textTheme.bodyMedium),
          ),
        ],
      ),
    );
  }
}

/// Self password-change dialog. Mirrors the web `ChangePasswordDialog` (FE2):
/// current + new + confirm, min-length 8, posts to `POST /api/v1/me/password`.
class ChangePasswordDialog extends ConsumerStatefulWidget {
  const ChangePasswordDialog({super.key});

  static const minLength = 8;

  @override
  ConsumerState<ChangePasswordDialog> createState() =>
      _ChangePasswordDialogState();
}

class _ChangePasswordDialogState extends ConsumerState<ChangePasswordDialog> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _submitting = false;
  bool _done = false;
  String? _error;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  bool get _canSubmit =>
      _current.text.isNotEmpty &&
      _next.text.length >= ChangePasswordDialog.minLength &&
      _next.text == _confirm.text &&
      !_submitting;

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final client = await ref.read(gatewayClientProvider.future);
      await client.changePassword(_current.text, _next.text);
      if (mounted) setState(() => _done = true);
    } on DubApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = 'パスワードの変更に失敗しました。');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tooShort = _next.text.isNotEmpty &&
        _next.text.length < ChangePasswordDialog.minLength;
    final mismatch = _confirm.text.isNotEmpty && _next.text != _confirm.text;

    return AlertDialog(
      title: const Text('パスワードを変更'),
      content: SizedBox(
        width: 380,
        child: _done
            ? const Text('パスワードを変更しました。次回のログインから新しいパスワードを使用してください。')
            : Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: _current,
                    obscureText: true,
                    enabled: !_submitting,
                    onChanged: (_) => setState(() {}),
                    decoration: const InputDecoration(
                      labelText: '現在のパスワード',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _next,
                    obscureText: true,
                    enabled: !_submitting,
                    onChanged: (_) => setState(() {}),
                    decoration: InputDecoration(
                      labelText:
                          '新しいパスワード（${ChangePasswordDialog.minLength}文字以上）',
                      border: const OutlineInputBorder(),
                      errorText: tooShort ? '短すぎます' : null,
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _confirm,
                    obscureText: true,
                    enabled: !_submitting,
                    onChanged: (_) => setState(() {}),
                    decoration: InputDecoration(
                      labelText: '新しいパスワード（確認）',
                      border: const OutlineInputBorder(),
                      errorText: mismatch ? '新しいパスワードが一致しません。' : null,
                    ),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!,
                        style: TextStyle(color: theme.colorScheme.error)),
                  ],
                ],
              ),
      ),
      actions: _done
          ? [
              FilledButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('閉じる'),
              ),
            ]
          : [
              TextButton(
                onPressed:
                    _submitting ? null : () => Navigator.of(context).pop(),
                child: const Text('キャンセル'),
              ),
              FilledButton(
                onPressed: _canSubmit ? _submit : null,
                child: _submitting
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('変更する'),
              ),
            ],
    );
  }
}
