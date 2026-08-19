# DAV Desktop — Feature Module Guide

How to add a feature to `apps/de1-desktop` **without touching the shell or any
other feature's files**, so many agents can build features in parallel without
merge conflicts.

Read this before starting; it is short by design.

## The one rule

**1 feature = 1 folder + 1 module file + 1 line in the registry.**

- Everything for a feature lives under `lib/features/<feature>/`.
- The shell (`lib/ui/app_shell.dart`), the launcher, and navigation are all
  **derived from the registry** — you never edit them.
- The only shared file you touch is `lib/features/modules.dart`, where you add
  **one import + one list entry**. (A one-line append; trivial to merge.)

## Layout

```
lib/
  core/
    api_client.dart      ApiClient (shared HTTP over the gateway Dio) + apiClientProvider
    feature_module.dart  FeatureModule contract + ComingSoonModule
  state/
    auth.dart            gatewayClientProvider + authControllerProvider (session)
  features/
    modules.dart         <-- THE registry (the only shared file you edit)
    notifications/       reference implementation of the pattern
    chat/                first real feature (HTTP + DO-direct WebSocket)
    <your-feature>/      you add this
  ui/
    app_shell.dart       registry-driven shell — DO NOT edit to add a feature
    theme.dart           Material3 theme
```

## Steps

1. **Create the folder** `lib/features/<feature>/`.

2. **Add your API** in `<feature>_api.dart`. Wrap the shared `ApiClient` — never
   add methods to `GatewayClient` (that would be a shared-file conflict):

   ```dart
   class TasksApi {
     TasksApi(this._client);
     final ApiClient _client;
     Future<List<Task>> list() async {
       final json = await _client.getJson('/tasks'); // hits /api/v1/tasks
       return TaskList.fromJson(json).items;
     }
   }
   final tasksApiProvider = FutureProvider<TasksApi>((ref) async {
     return TasksApi(await ref.watch(apiClientProvider.future));
   });
   ```

   `ApiClient` gives you `getJson` / `getList` / `postJson`. Session cookies flow
   automatically (same Dio the login used). Non-2xx bodies throw
   `DubApiException` (from `api/models.dart`). Feature-specific wire models live
   in the feature (`<feature>_models.dart`) — only cross-feature types
   (MeResponse, DubApiException) stay in `api/models.dart`.

3. **Add state** in `<feature>_providers.dart` (Riverpod). Use `.autoDispose` for
   per-view controllers so resources (sockets, timers) are torn down when the
   view is closed. See `chat/chat_providers.dart` for an optimistic-UI +
   WebSocket example.

4. **Add the view** in `<feature>_view.dart` (a `ConsumerWidget`). Use
   `Theme.of(context)` for colors/typography (the shared theme).

5. **Add the module** in `<feature>_module.dart`:

   ```dart
   class TasksModule extends FeatureModule {
     const TasksModule();
     @override String get id => 'tasks';
     @override String get label => 'タスク';
     @override IconData get icon => Icons.check_circle_outline;
     @override Widget buildView(BuildContext context) => const TasksView();
   }
   ```

6. **Register it** — the only shared edit — in `lib/features/modules.dart`.
   Replace the `ComingSoonModule` placeholder for your feature id with your real
   module (import + one line):

   ```dart
   import 'tasks/tasks_module.dart';
   ...
   const List<FeatureModule> kFeatureModules = [
     NotificationsModule(),
     ChatModule(),
     TasksModule(),            // <- was ComingSoonModule(id: 'tasks', ...)
     ...
   ];
   ```

That's it. The launcher shows your icon/label, selecting it renders your view,
and unbuilt features stay greyed-out with a lock (release-gating parity).

## Shared layer you rely on (do not fork)

| Need | Use |
|---|---|
| HTTP to the gateway | `apiClientProvider` → `ApiClient` (`core/api_client.dart`) |
| Current user / session / logout | `authControllerProvider` (`state/auth.dart`) — `.me?.user.id`, permissions |
| Error type | `DubApiException` (`api/models.dart`) |
| Theme / colors | `Theme.of(context)` (Material3, `ui/theme.dart`) |
| Realtime (WebSocket) | mint a ws-ticket via your feature API, then connect DO-direct — see `chat/chat_realtime.dart` (ADR-0002) |

## Adding a pubspec dependency

If your feature needs a new package, add it to the shared
`apps/de1-desktop/pubspec.yaml` under `dependencies:` and run `flutter pub get`.
Rules:

- **Prefer pure-Dart packages** (no native plugins) so macOS/Windows builds need
  no extra CocoaPods/registrant changes. `web_socket_channel` (chat) is an
  example.
- pubspec is shared, so a dependency add is a small conflict surface — keep adds
  grouped and commented, and coordinate if two agents add the same package.
- If a native plugin is unavoidable, call it out in the PR (it touches
  `macos/`/`windows/` generated registrants).

## Conflict-avoidance checklist (parallel agents)

- Only ever create files under your `lib/features/<feature>/`.
- The one shared edit is a single append line in `modules.dart` — rebase on
  `origin/main` before pushing so appends stack cleanly.
- Do not edit `ui/app_shell.dart`, other features' folders, or `core/`.
- Extending `core/` (e.g. a new `ApiClient` helper) is allowed but is a shared
  change — coordinate and keep it additive.

## Verifying

- `flutter analyze` and `flutter test` (unit tests: parse your wire models).
- For UI/flow proof, drive the real macOS app against `tool/mock_gateway.dart`
  (add your routes there) and capture screenshots — see
  `integration_test/chat_slice_test.dart` + `test_driver/chat_integration_test.dart`
  as the template.
