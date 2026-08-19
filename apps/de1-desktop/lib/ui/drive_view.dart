import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../state/drive.dart';
import 'shared.dart';

/// A single hop in the folder breadcrumb (null id = My Drive root).
class _Crumb {
  const _Crumb(this.id, this.name);
  final String? id;
  final String name;
}

/// Drive app: browse files and folders (`GET /api/v1/drive/files`). Tapping a
/// folder lists its children; a breadcrumb walks back up.
class DriveView extends ConsumerStatefulWidget {
  const DriveView({super.key});

  @override
  ConsumerState<DriveView> createState() => _DriveViewState();
}

class _DriveViewState extends ConsumerState<DriveView> {
  final List<_Crumb> _trail = [const _Crumb(null, 'マイドライブ')];

  void _open(DriveFile folder) {
    setState(() => _trail.add(_Crumb(folder.id, folder.name)));
    ref.read(driveFolderProvider.notifier).state = folder.id;
  }

  void _jumpTo(int index) {
    setState(() => _trail.removeRange(index + 1, _trail.length));
    ref.read(driveFolderProvider.notifier).state = _trail[index].id;
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(driveFilesProvider);
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 4),
          child: Row(
            children: [
              Text('ドライブ', style: theme.textTheme.headlineSmall),
              const Spacer(),
              IconButton(
                tooltip: '再読み込み',
                icon: const Icon(Icons.refresh),
                onPressed: () => ref.invalidate(driveFilesProvider),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
          child: _Breadcrumb(trail: _trail, onTap: _jumpTo),
        ),
        Expanded(
          child: async.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => FeatureErrorState(
              error: e,
              onRetry: () => ref.invalidate(driveFilesProvider),
            ),
            data: (page) => page.items.isEmpty
                ? const FeatureEmptyState(
                    icon: Icons.folder_off_outlined,
                    message: 'このフォルダは空です',
                  )
                : ListView.separated(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 24, vertical: 8),
                    itemCount: page.items.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 4),
                    itemBuilder: (_, i) => _FileTile(
                      file: page.items[i],
                      onOpenFolder: _open,
                    ),
                  ),
          ),
        ),
      ],
    );
  }
}

class _Breadcrumb extends StatelessWidget {
  const _Breadcrumb({required this.trail, required this.onTap});
  final List<_Crumb> trail;
  final void Function(int index) onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (var i = 0; i < trail.length; i++) ...[
            if (i > 0)
              Icon(Icons.chevron_right,
                  size: 18, color: theme.colorScheme.outline),
            InkWell(
              borderRadius: BorderRadius.circular(6),
              onTap: i == trail.length - 1 ? null : () => onTap(i),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                child: Text(
                  trail[i].name,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: i == trail.length - 1
                        ? theme.colorScheme.onSurface
                        : theme.colorScheme.primary,
                    fontWeight: i == trail.length - 1
                        ? FontWeight.w600
                        : FontWeight.w400,
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _FileTile extends StatelessWidget {
  const _FileTile({required this.file, required this.onOpenFolder});
  final DriveFile file;
  final void Function(DriveFile folder) onOpenFolder;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.surface,
      borderRadius: BorderRadius.circular(10),
      child: ListTile(
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(color: theme.colorScheme.outlineVariant),
        ),
        leading: Icon(
          _iconFor(file),
          color: file.isFolder
              ? theme.colorScheme.primary
              : theme.colorScheme.onSurfaceVariant,
        ),
        title: Text(file.name, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text(
          formatWhen(file.modifiedAt) ?? file.mimeType,
          style: theme.textTheme.bodySmall,
        ),
        trailing: file.isFolder
            ? Icon(Icons.chevron_right, color: theme.colorScheme.outline)
            : null,
        onTap: file.isFolder ? () => onOpenFolder(file) : null,
      ),
    );
  }

  static IconData _iconFor(DriveFile f) {
    if (f.isFolder) return Icons.folder_outlined;
    final m = f.mimeType;
    if (m.contains('spreadsheet')) return Icons.table_chart_outlined;
    if (m.contains('document')) return Icons.description_outlined;
    if (m.contains('presentation')) return Icons.slideshow_outlined;
    if (m.startsWith('image/')) return Icons.image_outlined;
    if (m == 'application/pdf') return Icons.picture_as_pdf_outlined;
    return Icons.insert_drive_file_outlined;
  }
}
