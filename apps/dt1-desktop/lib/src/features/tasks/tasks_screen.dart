import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import 'tasks_repository.dart';

/// マイタスク — tasks assigned to the signed-in user
/// (`GET /api/v1/tasks?assigneeId=<me>`).
class TasksScreen extends StatefulWidget {
  const TasksScreen({super.key, required this.repository, required this.userId});

  final TasksRepository repository;
  final String userId;

  @override
  State<TasksScreen> createState() => _TasksScreenState();
}

class _TasksScreenState extends State<TasksScreen> {
  late Future<List<TaskItem>> _future = _load();

  Future<List<TaskItem>> _load() =>
      widget.repository.fetchMyTasks(assigneeId: widget.userId);

  void _reload() => setState(() => _future = _load());

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
          child: Row(
            children: [
              Text('マイタスク', style: Theme.of(context).textTheme.headlineSmall),
              const Spacer(),
              IconButton(onPressed: _reload, icon: const Icon(Icons.refresh)),
            ],
          ),
        ),
        Expanded(
          child: AsyncView<List<TaskItem>>(
            future: _future,
            onRetry: _reload,
            emptyCheck: (list) => list.isEmpty,
            emptyLabel: '割り当てられたタスクはありません',
            onData: (context, items) => ListView.separated(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, i) => _TaskTile(task: items[i]),
            ),
          ),
        ),
      ],
    );
  }
}

class _TaskTile extends StatelessWidget {
  const _TaskTile({required this.task});

  final TaskItem task;

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return Card(
      child: ListTile(
        leading: Icon(
          task.isDone ? Icons.check_circle : Icons.radio_button_unchecked,
          color: task.isDone ? c.success : c.textMuted,
        ),
        title: Text(
          task.title,
          style: TextStyle(
            decoration: task.isDone ? TextDecoration.lineThrough : null,
          ),
        ),
        subtitle: Row(
          children: [
            _Pill(text: _statusLabel(task.status), color: _statusColor(task.status, c)),
            const SizedBox(width: 6),
            _Pill(text: task.priority, color: c.textMuted),
          ],
        ),
        trailing: task.dueAt != null
            ? Text('〆 ${_fmtDate(task.dueAt!)}',
                style: TextStyle(color: c.textMuted, fontSize: 12))
            : null,
      ),
    );
  }

  String _statusLabel(String s) => switch (s) {
        'todo' => '未着手',
        'in_progress' => '進行中',
        'blocked' => 'ブロック',
        'done' => '完了',
        _ => s,
      };

  Color _statusColor(String s, dynamic c) => switch (s) {
        'in_progress' => c.info as Color,
        'blocked' => c.danger as Color,
        'done' => c.success as Color,
        _ => c.textMuted as Color,
      };
}

class _Pill extends StatelessWidget {
  const _Pill({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(text, style: TextStyle(color: color, fontSize: 11)),
    );
  }
}

String _fmtDate(DateTime d) =>
    '${d.month.toString().padLeft(2, '0')}/${d.day.toString().padLeft(2, '0')}';
