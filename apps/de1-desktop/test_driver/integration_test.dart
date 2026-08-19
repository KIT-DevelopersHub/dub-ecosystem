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
        final file = File('${dir.path}/vertical-slice-inbox.png');
        file.writeAsBytesSync(bytes);
        stdout.writeln('saved screenshot ${file.path} (${bytes.length} bytes)');
      }
    },
  );
}
