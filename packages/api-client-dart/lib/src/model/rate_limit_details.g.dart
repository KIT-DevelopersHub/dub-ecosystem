// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'rate_limit_details.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$RateLimitDetails extends RateLimitDetails {
  @override
  final int retryAfterSec;

  factory _$RateLimitDetails(
          [void Function(RateLimitDetailsBuilder)? updates]) =>
      (RateLimitDetailsBuilder()..update(updates))._build();

  _$RateLimitDetails._({required this.retryAfterSec}) : super._();
  @override
  RateLimitDetails rebuild(void Function(RateLimitDetailsBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  RateLimitDetailsBuilder toBuilder() =>
      RateLimitDetailsBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is RateLimitDetails && retryAfterSec == other.retryAfterSec;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, retryAfterSec.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'RateLimitDetails')
          ..add('retryAfterSec', retryAfterSec))
        .toString();
  }
}

class RateLimitDetailsBuilder
    implements Builder<RateLimitDetails, RateLimitDetailsBuilder> {
  _$RateLimitDetails? _$v;

  int? _retryAfterSec;
  int? get retryAfterSec => _$this._retryAfterSec;
  set retryAfterSec(int? retryAfterSec) =>
      _$this._retryAfterSec = retryAfterSec;

  RateLimitDetailsBuilder() {
    RateLimitDetails._defaults(this);
  }

  RateLimitDetailsBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _retryAfterSec = $v.retryAfterSec;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(RateLimitDetails other) {
    _$v = other as _$RateLimitDetails;
  }

  @override
  void update(void Function(RateLimitDetailsBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  RateLimitDetails build() => _build();

  _$RateLimitDetails _build() {
    final _$result = _$v ??
        _$RateLimitDetails._(
          retryAfterSec: BuiltValueNullFieldError.checkNotNull(
              retryAfterSec, r'RateLimitDetails', 'retryAfterSec'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
