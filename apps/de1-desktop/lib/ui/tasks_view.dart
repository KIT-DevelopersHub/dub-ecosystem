import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../api/task_models.dart';
import '../state/tasks.dart';

/// Tasks app: list + detail + optimistic status change + assignee assignment,
/// live over the shared gateway (`/api/v1/tasks`). Every mutation reflects
/// immediately and rolls back with a toast on failure (optimistic-UI principle).
class TasksView extends ConsumerWidget {
  const TasksView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(tasksControllerProvider);
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
          child: Row(
            children: [
              Text('タスク', style: theme.textTheme.headlineSmall),
              const Spacer(),
              IconButton(
                tooltip: '再読み込み',
                icon: const Icon(Icons.refresh),
                onPressed: () =>
                    ref.read(tasksControllerProvider.notifier).load(),
              ),
            ],
          ),
        ),
        Expanded(
          child: async.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => _ErrorState(
              error: e,
              onRetry: () => ref.read(tasksControllerProvider.notifier).load(),
            ),
            data: (tasks) => tasks.isEmpty
                ? const _EmptyState()
                : ListView.separated(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 24, vertical: 8),
                    itemCount: tasks.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 8),
                    itemBuilder: (_, i) => _TaskTile(task: tasks[i]),
                  ),
          ),
        ),
      ],
    );
  }
}

/// Resolve an assignee id to a display name via the roster, falling back to the
/// raw id (the roster call needs `identity:read`, which not every user has).
String _assigneeLabel(WidgetRef ref, String? assigneeId) {
  if (assigneeId == null) return '未割当';
  final roster = ref.watch(rosterProvider).valueOrNull ?? const [];
  for (final u in roster) {
    if (u.id == assigneeId) return u.displayName;
  }
  return assigneeId;
}

class _TaskTile extends ConsumerWidget {
  const _TaskTile({required this.task});
  final Task task;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    return Container(
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => _openDetail(context, ref, task.id),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          _PriorityDot(priority: task.priority),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              task.title,
                              style: theme.textTheme.titleSmall
                                  ?.copyWith(fontWeight: FontWeight.w600),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          _AssigneeChip(task: task),
                          const SizedBox(width: 8),
                          if (task.dueAt != null)
                            _MetaText(
                              icon: Icons.event_outlined,
                              text: _fmtDate(task.dueAt!),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                _StatusControl(task: task),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A status chip that, on tap, offers the valid next statuses and applies the
/// chosen one optimistically.
class _StatusControl extends ConsumerWidget {
  const _StatusControl({required this.task});
  final Task task;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final transitions = kTaskStatusTransitions[task.status] ?? const [];
    return PopupMenuButton<TaskStatus>(
      tooltip: '状態を変更',
      enabled: transitions.isNotEmpty,
      onSelected: (next) => _applyStatus(context, ref, task.id, next),
      itemBuilder: (_) => [
        for (final s in transitions)
          PopupMenuItem(
            value: s,
            child: Row(
              children: [
                _StatusDot(status: s),
                const SizedBox(width: 8),
                Text(s.label),
              ],
            ),
          ),
      ],
      child: _StatusChip(status: task.status, actionable: transitions.isNotEmpty),
    );
  }
}

Future<void> _applyStatus(
  BuildContext context,
  WidgetRef ref,
  String id,
  TaskStatus next,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final err =
      await ref.read(tasksControllerProvider.notifier).changeStatus(id, next);
  if (err != null) {
    messenger
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text('状態を変更できませんでした: $err')));
  }
}

class _AssigneeChip extends ConsumerWidget {
  const _AssigneeChip({required this.task});
  final Task task;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final label = _assigneeLabel(ref, task.assigneeId);
    final unassigned = task.assigneeId == null;
    return InkWell(
      borderRadius: BorderRadius.circular(20),
      onTap: () => _pickAssignee(context, ref, task),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: theme.colorScheme.outlineVariant),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              unassigned ? Icons.person_add_alt : Icons.person_outline,
              size: 15,
              color: unassigned
                  ? theme.colorScheme.outline
                  : theme.colorScheme.primary,
            ),
            const SizedBox(width: 6),
            Text(
              label,
              style: theme.textTheme.bodySmall?.copyWith(
                color: unassigned ? theme.colorScheme.outline : null,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Future<void> _pickAssignee(
    BuildContext context, WidgetRef ref, Task task) async {
  final roster = ref.read(rosterProvider).valueOrNull ?? const [];
  final messenger = ScaffoldMessenger.of(context);

  final selection = await showModalBottomSheet<_AssigneeChoice>(
    context: context,
    showDragHandle: true,
    builder: (ctx) {
      return SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 4, 20, 12),
              child: Text('担当者を選択',
                  style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
            ),
            ListTile(
              leading: const Icon(Icons.person_off_outlined),
              title: const Text('未割当にする'),
              enabled: task.assigneeId != null,
              onTap: () =>
                  Navigator.of(ctx).pop(const _AssigneeChoice(null)),
            ),
            if (roster.isEmpty)
              const Padding(
                padding: EdgeInsets.all(20),
                child: Text('割り当て可能なメンバー一覧を取得できませんでした。',
                    style: TextStyle(color: Colors.grey)),
              )
            else
              for (final u in roster)
                ListTile(
                  leading: CircleAvatar(
                    radius: 14,
                    child: Text(u.displayName.isEmpty
                        ? '?'
                        : u.displayName.characters.first),
                  ),
                  title: Text(u.displayName),
                  subtitle: u.email == null ? null : Text(u.email!),
                  trailing: u.id == task.assigneeId
                      ? const Icon(Icons.check, size: 18)
                      : null,
                  onTap: () => Navigator.of(ctx).pop(_AssigneeChoice(u.id)),
                ),
          ],
        ),
      );
    },
  );

  if (selection == null) return; // dismissed
  final err = await ref
      .read(tasksControllerProvider.notifier)
      .assign(task.id, selection.id);
  if (err != null) {
    messenger
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text('担当を変更できませんでした: $err')));
  }
}

/// Wrapper so a null id ("unassign") is distinguishable from a dismissed sheet.
class _AssigneeChoice {
  const _AssigneeChoice(this.id);
  final String? id;
}

void _openDetail(BuildContext context, WidgetRef ref, String taskId) {
  showDialog<void>(
    context: context,
    builder: (_) => _TaskDetailDialog(taskId: taskId),
  );
}

/// Detail view. Reads the task straight from the controller's live list so it
/// reflects optimistic updates instantly and stays in sync after reconcile.
class _TaskDetailDialog extends ConsumerWidget {
  const _TaskDetailDialog({required this.taskId});
  final String taskId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final tasks = ref.watch(tasksControllerProvider).valueOrNull ?? const [];
    Task? task;
    for (final t in tasks) {
      if (t.id == taskId) {
        task = t;
        break;
      }
    }
    if (task == null) {
      return const AlertDialog(content: Text('タスクが見つかりません'));
    }
    final t = task;

    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _PriorityDot(priority: t.priority),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(t.title, style: theme.textTheme.titleLarge),
                  ),
                  IconButton(
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Text('状態', style: theme.textTheme.labelMedium),
                  const SizedBox(width: 12),
                  _StatusControl(task: t),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Text('担当', style: theme.textTheme.labelMedium),
                  const SizedBox(width: 12),
                  _AssigneeChip(task: t),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Text('優先度', style: theme.textTheme.labelMedium),
                  const SizedBox(width: 12),
                  Text(t.priority.label, style: theme.textTheme.bodyMedium),
                  if (t.dueAt != null) ...[
                    const SizedBox(width: 20),
                    Text('期限', style: theme.textTheme.labelMedium),
                    const SizedBox(width: 12),
                    Text(_fmtDate(t.dueAt!), style: theme.textTheme.bodyMedium),
                  ],
                ],
              ),
              if (t.description != null && t.description!.isNotEmpty) ...[
                const SizedBox(height: 16),
                Text('説明', style: theme.textTheme.labelMedium),
                const SizedBox(height: 4),
                Text(t.description!, style: theme.textTheme.bodyMedium),
              ],
              const SizedBox(height: 16),
              Text(
                'ID ${t.id} · v${t.version}',
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.outline),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// --- small presentational bits ---

Color _statusColor(TaskStatus s, ColorScheme c) => switch (s) {
      TaskStatus.todo => c.outline,
      TaskStatus.inProgress => c.primary,
      TaskStatus.blocked => c.error,
      TaskStatus.done => Colors.green.shade600,
      TaskStatus.cancelled => c.outlineVariant,
    };

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status, required this.actionable});
  final TaskStatus status;
  final bool actionable;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = _statusColor(status, theme.colorScheme);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _StatusDot(status: status),
          const SizedBox(width: 6),
          Text(
            status.label,
            style: theme.textTheme.labelMedium
                ?.copyWith(color: color, fontWeight: FontWeight.w600),
          ),
          if (actionable) ...[
            const SizedBox(width: 2),
            Icon(Icons.arrow_drop_down, size: 18, color: color),
          ],
        ],
      ),
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.status});
  final TaskStatus status;

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(status, Theme.of(context).colorScheme);
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

class _PriorityDot extends StatelessWidget {
  const _PriorityDot({required this.priority});
  final TaskPriority priority;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = switch (priority) {
      TaskPriority.low => theme.colorScheme.outline,
      TaskPriority.medium => theme.colorScheme.primary,
      TaskPriority.high => Colors.orange.shade700,
      TaskPriority.urgent => theme.colorScheme.error,
    };
    return Tooltip(
      message: '優先度: ${priority.label}',
      child: Container(
        width: 10,
        height: 10,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      ),
    );
  }
}

class _MetaText extends StatelessWidget {
  const _MetaText({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: theme.colorScheme.outline),
        const SizedBox(width: 4),
        Text(text,
            style: theme.textTheme.bodySmall
                ?.copyWith(color: theme.colorScheme.outline)),
      ],
    );
  }
}

String _fmtDate(String iso) {
  final dt = DateTime.tryParse(iso);
  if (dt == null) return iso;
  final l = dt.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.year}/${two(l.month)}/${two(l.day)}';
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.check_circle_outline,
              size: 48, color: theme.colorScheme.outline),
          const SizedBox(height: 8),
          const Text('タスクはありません'),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final message =
        error is DubApiException ? (error as DubApiException).message : '$error';
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.error_outline, size: 44, color: theme.colorScheme.error),
          const SizedBox(height: 8),
          Text('読み込みに失敗しました', style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(message,
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.outline)),
          const SizedBox(height: 12),
          FilledButton.tonal(onPressed: onRetry, child: const Text('再試行')),
        ],
      ),
    );
  }
}
