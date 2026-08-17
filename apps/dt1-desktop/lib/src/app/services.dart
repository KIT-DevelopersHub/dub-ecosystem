import 'package:dio/dio.dart';

import '../api/gateway_client.dart';
import '../api/proxy_repository.dart';
import '../auth/auth_controller.dart';
import '../auth/auth_repository.dart';
import '../config/app_config.dart';
import '../features/events/events_repository.dart';
import '../features/gantt/gantt_repository.dart';
import '../features/home/home_repository.dart';
import '../features/me/me_repository.dart';
import '../features/notifications/notifications_repository.dart';
import '../features/tasks/tasks_repository.dart';

/// The composition root: one gateway transport + one [AuthController] + all
/// feature repositories, built once at startup and passed down the widget tree.
/// The gateway client reads the auth token live, so the same instances serve
/// both the signed-out and signed-in phases.
class AppServices {
  AppServices._({
    required this.auth,
    required this.me,
    required this.home,
    required this.notifications,
    required this.tasks,
    required this.gantt,
    required this.events,
  });

  final AuthController auth;
  final MeRepository me;
  final HomeRepository home;
  final NotificationsRepository notifications;
  final TasksRepository tasks;
  final GanttRepository gantt;
  final EventsRepository events;

  /// [adapter] injects an in-memory backend for tests/screenshots; production
  /// leaves it null and talks to the real gateway over the network.
  factory AppServices.bootstrap(AppConfig config, {HttpClientAdapter? adapter}) {
    // The controller is created first; the gateway reads its token via closure,
    // so login/logout take effect on the shared client with no rebuild.
    late final AuthController auth;

    final gateway = Gateway.create(config, tokenProvider: () => auth.token, adapter: adapter);
    final proxy = ProxyClient(gateway.dio);

    final me = MeRepository(gateway.api);
    auth = AuthController(authRepo: AuthRepository(gateway.dio), meRepo: me);

    return AppServices._(
      auth: auth,
      me: me,
      home: HomeRepository(gateway.api),
      notifications: NotificationsRepository(proxy),
      tasks: TasksRepository(proxy),
      gantt: GanttRepository(proxy),
      events: EventsRepository(proxy),
    );
  }
}
