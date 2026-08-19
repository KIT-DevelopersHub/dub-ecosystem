import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/models.dart' show DubApiException;
import 'roster_models.dart';
import 'roster_providers.dart';

/// Roster feature: the member name-list with per-member role display, plus the
/// Email Routing destination addresses ("メール名簿"). Data only — the visual
/// polish is intentionally minimal for the owner to adjust later.
class RosterView extends ConsumerWidget {
  const RosterView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
          child: Row(
            children: [
              Text('名簿', style: theme.textTheme.headlineSmall),
              const Spacer(),
              IconButton(
                tooltip: '再読み込み',
                icon: const Icon(Icons.refresh),
                onPressed: () {
                  ref.invalidate(rosterMembersProvider);
                  ref.invalidate(emailRoutingAddressesProvider);
                },
              ),
            ],
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
            children: const [
              _SectionHeader(
                icon: Icons.groups_outlined,
                title: 'メンバー',
                subtitle: '各メンバーの表示名・メール・ロール',
              ),
              SizedBox(height: 8),
              _MembersSection(),
              SizedBox(height: 28),
              _SectionHeader(
                icon: Icons.alternate_email,
                title: 'メール転送先 (Email Routing)',
                subtitle: 'Cloudflare Email Routing の転送先アドレス一覧',
              ),
              SizedBox(height: 8),
              _EmailRoutingSection(),
            ],
          ),
        ),
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 20, color: theme.colorScheme.primary),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: theme.textTheme.titleMedium),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.outline),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _MembersSection extends ConsumerWidget {
  const _MembersSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(rosterMembersProvider);
    return async.when(
      loading: () => const _SectionLoading(),
      error: (e, _) => _SectionError(
        error: e,
        onRetry: () => ref.invalidate(rosterMembersProvider),
      ),
      data: (members) => members.isEmpty
          ? const _SectionEmpty(message: 'メンバーがいません')
          : Column(
              children: [
                for (final m in members)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: _MemberTile(member: m),
                  ),
              ],
            ),
    );
  }
}

class _MemberTile extends StatelessWidget {
  const _MemberTile({required this.member});
  final RosterMember member;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final user = member.user;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            radius: 18,
            backgroundColor: theme.colorScheme.primaryContainer,
            child: Text(
              _initial(user.displayName, user.email),
              style: TextStyle(color: theme.colorScheme.onPrimaryContainer),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        user.displayName.isEmpty ? user.email : user.displayName,
                        style: theme.textTheme.titleSmall
                            ?.copyWith(fontWeight: FontWeight.w600),
                      ),
                    ),
                    _StatusChip(status: user.status),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  user.email,
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: theme.colorScheme.outline),
                ),
                const SizedBox(height: 8),
                if (member.roleNames.isEmpty)
                  Text(
                    'ロール未割り当て',
                    style: theme.textTheme.labelSmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  )
                else
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      for (final r in member.roleNames) _RoleChip(name: r),
                    ],
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  static String _initial(String name, String email) {
    final source = name.isNotEmpty ? name : email;
    if (source.isEmpty) return '?';
    return source.characters.first.toUpperCase();
  }
}

class _RoleChip extends StatelessWidget {
  const _RoleChip({required this.name});
  final String name;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: theme.colorScheme.secondaryContainer,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        name,
        style: theme.textTheme.labelSmall
            ?.copyWith(color: theme.colorScheme.onSecondaryContainer),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});
  final UserStatus status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final active = status == UserStatus.active;
    final color =
        active ? theme.colorScheme.primary : theme.colorScheme.outline;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        border: Border.all(color: color),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        status.label,
        style: theme.textTheme.labelSmall?.copyWith(color: color),
      ),
    );
  }
}

class _EmailRoutingSection extends ConsumerWidget {
  const _EmailRoutingSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(emailRoutingAddressesProvider);
    return async.when(
      loading: () => const _SectionLoading(),
      error: (e, _) => _SectionError(
        error: e,
        onRetry: () => ref.invalidate(emailRoutingAddressesProvider),
      ),
      data: (addresses) => addresses.isEmpty
          ? const _SectionEmpty(message: '転送先アドレスがありません')
          : Container(
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surface,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                    color: Theme.of(context).colorScheme.outlineVariant),
              ),
              child: Column(
                children: [
                  for (var i = 0; i < addresses.length; i++) ...[
                    if (i > 0)
                      Divider(
                        height: 1,
                        color: Theme.of(context).colorScheme.outlineVariant,
                      ),
                    _AddressRow(address: addresses[i]),
                  ],
                ],
              ),
            ),
    );
  }
}

class _AddressRow extends StatelessWidget {
  const _AddressRow({required this.address});
  final EmailRoutingAddress address;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        children: [
          Icon(
            address.isVerified ? Icons.verified_outlined : Icons.schedule,
            size: 18,
            color: address.isVerified
                ? theme.colorScheme.primary
                : theme.colorScheme.outline,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(address.email, style: theme.textTheme.bodyMedium),
          ),
          Text(
            address.isVerified ? '確認済み' : '未確認',
            style: theme.textTheme.labelSmall?.copyWith(
              color: address.isVerified
                  ? theme.colorScheme.primary
                  : theme.colorScheme.outline,
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionLoading extends StatelessWidget {
  const _SectionLoading();
  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 24),
      child: Center(child: CircularProgressIndicator()),
    );
  }
}

class _SectionEmpty extends StatelessWidget {
  const _SectionEmpty({required this.message});
  final String message;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 20),
      alignment: Alignment.center,
      child: Text(
        message,
        style:
            theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline),
      ),
    );
  }
}

class _SectionError extends StatelessWidget {
  const _SectionError({required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isForbidden =
        error is DubApiException && (error as DubApiException).statusCode == 403;
    final message = error is DubApiException
        ? (error as DubApiException).message
        : '$error';
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline, size: 20, color: theme.colorScheme.error),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isForbidden ? '閲覧権限がありません' : '読み込みに失敗しました',
                  style: theme.textTheme.titleSmall,
                ),
                const SizedBox(height: 2),
                Text(
                  message,
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: theme.colorScheme.outline),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          TextButton(onPressed: onRetry, child: const Text('再試行')),
        ],
      ),
    );
  }
}
