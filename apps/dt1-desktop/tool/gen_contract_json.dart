// Exports the desktop's contract-facing constants to committed JSON so the
// Node-side reconciliation tests (which cannot import Dart) can read them:
//
//   apps/dt1-desktop/contract/desktop_wire.g.json      <- kDesktopWire
//   apps/dt1-desktop/contract/desktop_apps.g.json      <- kDesktopApps ids
//
// These are the machine-readable "faces" the wire-contract + parity tests in
// packages/e2e-smoke reconcile against the @dub/types SoT. Committed, with a
// --check mode so CI fails on a stale export ("regenerate → diff = red").
//
//   dart run tool/gen_contract_json.dart          # regenerate
//   dart run tool/gen_contract_json.dart --check  # fail if stale
import 'dart:convert';
import 'dart:io';

import 'package:dt1_desktop/src/app/app_registry_data.dart';
import 'package:dt1_desktop/src/api/wire.dart';

void main(List<String> args) {
  final check = args.contains('--check');
  final dir = Directory('${Directory.current.path}/contract')..createSync(recursive: true);

  final wire = {
    for (final entry in kDesktopWire.entries)
      entry.key: {
        'method': entry.value.method,
        'path': entry.value.path,
        'query': entry.value.query,
      }
  };

  final apps = [
    for (final a in kDesktopAppData)
      {
        'id': a.id,
        'label': a.label,
        'navPath': a.navPath,
        'permission': a.permission,
        'status': a.status.name,
        'openToAllAuthenticated': a.openToAllAuthenticated,
      }
  ];

  final files = {
    '${dir.path}/desktop_wire.g.json': wire,
    '${dir.path}/desktop_apps.g.json': apps,
  };

  var stale = false;
  files.forEach((path, data) {
    final json = '${const JsonEncoder.withIndent('  ').convert(data)}\n';
    final file = File(path);
    if (check) {
      final current = file.existsSync() ? file.readAsStringSync() : '';
      if (current != json) {
        stderr.writeln('error: $path is stale. Run: dart run tool/gen_contract_json.dart');
        stale = true;
      }
    } else {
      file.writeAsStringSync(json);
      stdout.writeln('wrote $path');
    }
  });

  if (check && stale) exit(1);
  if (check) stdout.writeln('contract JSON is up to date');
}
