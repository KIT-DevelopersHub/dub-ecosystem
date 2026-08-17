import 'package:flutter/material.dart';

import 'src/app/root_app.dart';
import 'src/app/services.dart';
import 'src/config/app_config.dart';

void main() {
  final config = AppConfig.fromEnvironment();
  final services = AppServices.bootstrap(config);
  runApp(DubDesktopApp(services: services));
}
