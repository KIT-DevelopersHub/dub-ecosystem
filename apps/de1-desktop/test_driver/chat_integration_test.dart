import 'dart:convert';
import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

/// Driver for the chat slice: writes every `*_b64` entry in reportData as
/// `integration_test/screenshots/<key>.png`.
Future<void> main() async {
  final dir = Directory('integration_test/screenshots');
  if (!dir.existsSync()) dir.createSync(recursive: true);

  await integrationDriver(
    responseDataCallback: (Map<String, dynamic>? data) async {
      if (data == null) return;
      for (final entry in data.entries) {
        if (!entry.key.endsWith('_b64')) continue;
        final bytes = base64Decode(entry.value as String);
        final name = entry.key.substring(0, entry.key.length - '_b64'.length);
        final file = File('${dir.path}/$name.png');
        file.writeAsBytesSync(bytes);
        stdout.writeln('saved screenshot ${file.path} (${bytes.length} bytes)');
      }
    },
  );
}
