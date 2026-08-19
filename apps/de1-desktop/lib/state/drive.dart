import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import 'auth.dart';

/// Which Drive folder is currently open (null = My Drive root).
final driveFolderProvider = StateProvider<String?>((_) => null);

/// Files/folders directly under the currently-open folder
/// (`GET /api/v1/drive/files?folderId=...`).
final driveFilesProvider = FutureProvider<PaginatedDriveFiles>((ref) async {
  final client = await ref.watch(gatewayClientProvider.future);
  final folderId = ref.watch(driveFolderProvider);
  return client.listDriveFiles(limit: 50, folderId: folderId);
});
