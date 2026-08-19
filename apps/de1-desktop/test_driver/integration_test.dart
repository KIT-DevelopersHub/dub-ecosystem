import 'dart:convert';
import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() async {
  final dir = Directory('integration_test/screenshots');
  if (!dir.existsSync()) dir.createSync(recursive: true);

  // Also mirror captures into the DubVault docs folder the task expects.
  final home = Platform.environment['HOME'] ?? '';
  final vault = home.isEmpty
      ? null
      : Directory('$home/DubVault/docs/dav-desktop-flutter');
  vault?.createSync(recursive: true);

  // reportData key -> output basename (without extension).
  const outputs = <String, String>{
    'screenshot_b64': 'vertical-slice-inbox',
    'events_b64': 'events-list',
    'drive_b64': 'drive-list',
    'settings_b64': 'settings-profile',
  };

  await integrationDriver(
    responseDataCallback: (Map<String, dynamic>? data) async {
      if (data == null) return;
      for (final entry in outputs.entries) {
        final b64 = data[entry.key] as String?;
        if (b64 == null) continue;
        final bytes = base64Decode(b64);
        final local = File('${dir.path}/${entry.value}.png')
          ..writeAsBytesSync(bytes);
        stdout.writeln('saved ${local.path} (${bytes.length} bytes)');
        if (vault != null) {
          File('${vault.path}/${entry.value}.png').writeAsBytesSync(bytes);
        }
      }
    },
  );
}
