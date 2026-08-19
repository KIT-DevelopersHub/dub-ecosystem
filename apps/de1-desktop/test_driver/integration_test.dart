import 'dart:convert';
import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() async {
  final dir = Directory('integration_test/screenshots');
  if (!dir.existsSync()) dir.createSync(recursive: true);

  await integrationDriver(
    responseDataCallback: (Map<String, dynamic>? data) async {
      final b64 = data?['screenshot_b64'] as String?;
      if (b64 != null) {
        final bytes = base64Decode(b64);
        // Optional per-test name (defaults to the original slice screenshot).
        final name = (data?['name'] as String?) ?? 'vertical-slice-inbox';
        final file = File('${dir.path}/$name.png');
        file.writeAsBytesSync(bytes);
        stdout.writeln('saved screenshot ${file.path} (${bytes.length} bytes)');
      }
    },
  );
}
