// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'upstream_partial_error.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$UpstreamPartialError extends UpstreamPartialError {
  @override
  final String source_;
  @override
  final String code;

  factory _$UpstreamPartialError(
          [void Function(UpstreamPartialErrorBuilder)? updates]) =>
      (UpstreamPartialErrorBuilder()..update(updates))._build();

  _$UpstreamPartialError._({required this.source_, required this.code})
      : super._();
  @override
  UpstreamPartialError rebuild(
          void Function(UpstreamPartialErrorBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  UpstreamPartialErrorBuilder toBuilder() =>
      UpstreamPartialErrorBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is UpstreamPartialError &&
        source_ == other.source_ &&
        code == other.code;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, source_.hashCode);
    _$hash = $jc(_$hash, code.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'UpstreamPartialError')
          ..add('source_', source_)
          ..add('code', code))
        .toString();
  }
}

class UpstreamPartialErrorBuilder
    implements Builder<UpstreamPartialError, UpstreamPartialErrorBuilder> {
  _$UpstreamPartialError? _$v;

  String? _source_;
  String? get source_ => _$this._source_;
  set source_(String? source_) => _$this._source_ = source_;

  String? _code;
  String? get code => _$this._code;
  set code(String? code) => _$this._code = code;

  UpstreamPartialErrorBuilder() {
    UpstreamPartialError._defaults(this);
  }

  UpstreamPartialErrorBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _source_ = $v.source_;
      _code = $v.code;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(UpstreamPartialError other) {
    _$v = other as _$UpstreamPartialError;
  }

  @override
  void update(void Function(UpstreamPartialErrorBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  UpstreamPartialError build() => _build();

  _$UpstreamPartialError _build() {
    final _$result = _$v ??
        _$UpstreamPartialError._(
          source_: BuiltValueNullFieldError.checkNotNull(
              source_, r'UpstreamPartialError', 'source_'),
          code: BuiltValueNullFieldError.checkNotNull(
              code, r'UpstreamPartialError', 'code'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
