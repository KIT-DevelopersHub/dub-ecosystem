// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'me_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$MeResponse extends MeResponse {
  @override
  final UserSummary user;
  @override
  final String orgId;
  @override
  final BuiltList<String> permissions;
  @override
  final int sessionExpiresAt;

  factory _$MeResponse([void Function(MeResponseBuilder)? updates]) =>
      (MeResponseBuilder()..update(updates))._build();

  _$MeResponse._(
      {required this.user,
      required this.orgId,
      required this.permissions,
      required this.sessionExpiresAt})
      : super._();
  @override
  MeResponse rebuild(void Function(MeResponseBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  MeResponseBuilder toBuilder() => MeResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is MeResponse &&
        user == other.user &&
        orgId == other.orgId &&
        permissions == other.permissions &&
        sessionExpiresAt == other.sessionExpiresAt;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, user.hashCode);
    _$hash = $jc(_$hash, orgId.hashCode);
    _$hash = $jc(_$hash, permissions.hashCode);
    _$hash = $jc(_$hash, sessionExpiresAt.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'MeResponse')
          ..add('user', user)
          ..add('orgId', orgId)
          ..add('permissions', permissions)
          ..add('sessionExpiresAt', sessionExpiresAt))
        .toString();
  }
}

class MeResponseBuilder implements Builder<MeResponse, MeResponseBuilder> {
  _$MeResponse? _$v;

  UserSummaryBuilder? _user;
  UserSummaryBuilder get user => _$this._user ??= UserSummaryBuilder();
  set user(UserSummaryBuilder? user) => _$this._user = user;

  String? _orgId;
  String? get orgId => _$this._orgId;
  set orgId(String? orgId) => _$this._orgId = orgId;

  ListBuilder<String>? _permissions;
  ListBuilder<String> get permissions =>
      _$this._permissions ??= ListBuilder<String>();
  set permissions(ListBuilder<String>? permissions) =>
      _$this._permissions = permissions;

  int? _sessionExpiresAt;
  int? get sessionExpiresAt => _$this._sessionExpiresAt;
  set sessionExpiresAt(int? sessionExpiresAt) =>
      _$this._sessionExpiresAt = sessionExpiresAt;

  MeResponseBuilder() {
    MeResponse._defaults(this);
  }

  MeResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _user = $v.user.toBuilder();
      _orgId = $v.orgId;
      _permissions = $v.permissions.toBuilder();
      _sessionExpiresAt = $v.sessionExpiresAt;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(MeResponse other) {
    _$v = other as _$MeResponse;
  }

  @override
  void update(void Function(MeResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  MeResponse build() => _build();

  _$MeResponse _build() {
    _$MeResponse _$result;
    try {
      _$result = _$v ??
          _$MeResponse._(
            user: user.build(),
            orgId: BuiltValueNullFieldError.checkNotNull(
                orgId, r'MeResponse', 'orgId'),
            permissions: permissions.build(),
            sessionExpiresAt: BuiltValueNullFieldError.checkNotNull(
                sessionExpiresAt, r'MeResponse', 'sessionExpiresAt'),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'user';
        user.build();

        _$failedField = 'permissions';
        permissions.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'MeResponse', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
