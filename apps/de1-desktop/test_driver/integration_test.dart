import 'dart:convert';
import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() async {
  final dir = Directory('integration_test/screenshots');
  if (!dir.existsSync()) dir.createSync(recursive: true);

  void save(String name, String b64) {
    final bytes = base64Decode(b64);
    final file = File('${dir.path}/$name.png');
    file.writeAsBytesSync(bytes);
    stdout.writeln('saved screenshot ${file.path} (${bytes.length} bytes)');
  }

  await integrationDriver(
    responseDataCallback: (Map<String, dynamic>? data) async {
      // Legacy single-screenshot key (the notification slice).
      final b64 = data?['screenshot_b64'] as String?;
      if (b64 != null) save('vertical-slice-inbox', b64);

      // Name-aware multi-screenshot map: { name: base64Png } (e.g. the mail
      // slice captures mail-01-inbox, mail-02-thread, mail-03-compose).
      final shots = data?['screenshots'];
      if (shots is Map) {
        shots.forEach((name, value) {
          if (value is String) save(name.toString(), value);
        });
      }
    },
  );
}
