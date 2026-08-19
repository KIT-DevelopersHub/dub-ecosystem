import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/gateway_client.dart';
import '../api/models.dart';

/// Single async-initialised gateway client for the whole app.
final gatewayClientProvider = FutureProvider<GatewayClient>((ref) {
  return GatewayClient.create();
});

/// Authentication lifecycle.
enum AuthPhase { unknown, unauthenticated, authenticating, authenticated }

class AuthState {
  const AuthState({
    required this.phase,
    this.me,
    this.error,
  });

  final AuthPhase phase;
  final MeResponse? me;
  final String? error;

  const AuthState.unknown() : this(phase: AuthPhase.unknown);

  AuthState copyWith({
    AuthPhase? phase,
    MeResponse? me,
    String? error,
    bool clearError = false,
  }) {
    return AuthState(
      phase: phase ?? this.phase,
      me: me ?? this.me,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._ref) : super(const AuthState.unknown()) {
    _bootstrap();
  }

  final Ref _ref;

  Future<GatewayClient> get _client =>
      _ref.read(gatewayClientProvider.future);

  /// On launch, probe an existing (persisted-cookie) session via /me.
  Future<void> _bootstrap() async {
    try {
      final me = await (await _client).me();
      state = AuthState(phase: AuthPhase.authenticated, me: me);
    } on DubApiException {
      state = const AuthState(phase: AuthPhase.unauthenticated);
    } catch (_) {
      state = const AuthState(phase: AuthPhase.unauthenticated);
    }
  }

  Future<void> login(String email, String password) async {
    state = state.copyWith(phase: AuthPhase.authenticating, clearError: true);
    try {
      final client = await _client;
      await client.login(email, password);
      final me = await client.me();
      state = AuthState(phase: AuthPhase.authenticated, me: me);
    } on DubApiException catch (e) {
      state = AuthState(phase: AuthPhase.unauthenticated, error: e.message);
    } catch (e) {
      state = AuthState(
        phase: AuthPhase.unauthenticated,
        error: 'ネットワークエラー: $e',
      );
    }
  }

  Future<void> logout() async {
    try {
      await (await _client).logout();
    } catch (_) {
      // best-effort; cookies are cleared regardless.
    }
    state = const AuthState(phase: AuthPhase.unauthenticated);
  }
}

final authControllerProvider =
    StateNotifierProvider<AuthController, AuthState>((ref) {
  return AuthController(ref);
});
