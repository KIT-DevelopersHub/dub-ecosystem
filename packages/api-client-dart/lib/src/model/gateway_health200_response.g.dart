// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'gateway_health200_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$GatewayHealth200Response extends GatewayHealth200Response {
  @override
  final bool? ok;

  factory _$GatewayHealth200Response(
          [void Function(GatewayHealth200ResponseBuilder)? updates]) =>
      (GatewayHealth200ResponseBuilder()..update(updates))._build();

  _$GatewayHealth200Response._({this.ok}) : super._();
  @override
  GatewayHealth200Response rebuild(
          void Function(GatewayHealth200ResponseBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  GatewayHealth200ResponseBuilder toBuilder() =>
      GatewayHealth200ResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is GatewayHealth200Response && ok == other.ok;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, ok.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'GatewayHealth200Response')
          ..add('ok', ok))
        .toString();
  }
}

class GatewayHealth200ResponseBuilder
    implements
        Builder<GatewayHealth200Response, GatewayHealth200ResponseBuilder> {
  _$GatewayHealth200Response? _$v;

  bool? _ok;
  bool? get ok => _$this._ok;
  set ok(bool? ok) => _$this._ok = ok;

  GatewayHealth200ResponseBuilder() {
    GatewayHealth200Response._defaults(this);
  }

  GatewayHealth200ResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _ok = $v.ok;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(GatewayHealth200Response other) {
    _$v = other as _$GatewayHealth200Response;
  }

  @override
  void update(void Function(GatewayHealth200ResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  GatewayHealth200Response build() => _build();

  _$GatewayHealth200Response _build() {
    final _$result = _$v ??
        _$GatewayHealth200Response._(
          ok: ok,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
