import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'auth_controller.dart';

/// Interactive email + password login (the only interactive login — Google
/// OAuth was removed). On success [AuthController] flips to signedIn and the
/// shell replaces this screen.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.auth});

  final AuthController auth;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    await widget.auth.login(email: _email.text.trim(), password: _password.text);
  }

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 380),
            child: ListenableBuilder(
              listenable: widget.auth,
              builder: (context, _) {
                final busy = widget.auth.status == AuthStatus.authenticating;
                return Card(
                  child: Padding(
                    padding: const EdgeInsets.all(28),
                    child: Form(
                      key: _formKey,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Container(
                            height: 44,
                            width: 44,
                            decoration: BoxDecoration(
                              color: c.brand,
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: const Icon(Icons.hub, color: Colors.white),
                          ),
                          const SizedBox(height: 20),
                          Text('DevHub Desktop',
                              style: Theme.of(context).textTheme.headlineSmall),
                          const SizedBox(height: 4),
                          Text('会社アカウントでサインイン',
                              style: TextStyle(color: c.textMuted)),
                          const SizedBox(height: 24),
                          TextFormField(
                            controller: _email,
                            enabled: !busy,
                            autofocus: true,
                            keyboardType: TextInputType.emailAddress,
                            decoration: const InputDecoration(
                              labelText: 'メールアドレス',
                              border: OutlineInputBorder(),
                              prefixIcon: Icon(Icons.mail_outline),
                            ),
                            validator: (v) =>
                                (v == null || !v.contains('@')) ? 'メールアドレスを入力してください' : null,
                            onFieldSubmitted: (_) => _submit(),
                          ),
                          const SizedBox(height: 16),
                          TextFormField(
                            controller: _password,
                            enabled: !busy,
                            obscureText: true,
                            decoration: const InputDecoration(
                              labelText: 'パスワード',
                              border: OutlineInputBorder(),
                              prefixIcon: Icon(Icons.lock_outline),
                            ),
                            validator: (v) =>
                                (v == null || v.isEmpty) ? 'パスワードを入力してください' : null,
                            onFieldSubmitted: (_) => _submit(),
                          ),
                          if (widget.auth.error != null) ...[
                            const SizedBox(height: 16),
                            Row(
                              children: [
                                Icon(Icons.error_outline, color: c.danger, size: 18),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(widget.auth.error!,
                                      style: TextStyle(color: c.danger)),
                                ),
                              ],
                            ),
                          ],
                          const SizedBox(height: 24),
                          FilledButton(
                            onPressed: busy ? null : _submit,
                            child: Padding(
                              padding: const EdgeInsets.symmetric(vertical: 6),
                              child: busy
                                  ? const SizedBox(
                                      height: 18,
                                      width: 18,
                                      child: CircularProgressIndicator(strokeWidth: 2),
                                    )
                                  : const Text('サインイン'),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}
