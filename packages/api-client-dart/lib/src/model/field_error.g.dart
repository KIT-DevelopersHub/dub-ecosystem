// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'field_error.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$FieldError extends FieldError {
  @override
  final String field;
  @override
  final String reason;
  @override
  final String? message;

  factory _$FieldError([void Function(FieldErrorBuilder)? updates]) =>
      (FieldErrorBuilder()..update(updates))._build();

  _$FieldError._({required this.field, required this.reason, this.message})
      : super._();
  @override
  FieldError rebuild(void Function(FieldErrorBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  FieldErrorBuilder toBuilder() => FieldErrorBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is FieldError &&
        field == other.field &&
        reason == other.reason &&
        message == other.message;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, field.hashCode);
    _$hash = $jc(_$hash, reason.hashCode);
    _$hash = $jc(_$hash, message.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'FieldError')
          ..add('field', field)
          ..add('reason', reason)
          ..add('message', message))
        .toString();
  }
}

class FieldErrorBuilder implements Builder<FieldError, FieldErrorBuilder> {
  _$FieldError? _$v;

  String? _field;
  String? get field => _$this._field;
  set field(String? field) => _$this._field = field;

  String? _reason;
  String? get reason => _$this._reason;
  set reason(String? reason) => _$this._reason = reason;

  String? _message;
  String? get message => _$this._message;
  set message(String? message) => _$this._message = message;

  FieldErrorBuilder() {
    FieldError._defaults(this);
  }

  FieldErrorBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _field = $v.field;
      _reason = $v.reason;
      _message = $v.message;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(FieldError other) {
    _$v = other as _$FieldError;
  }

  @override
  void update(void Function(FieldErrorBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  FieldError build() => _build();

  _$FieldError _build() {
    final _$result = _$v ??
        _$FieldError._(
          field: BuiltValueNullFieldError.checkNotNull(
              field, r'FieldError', 'field'),
          reason: BuiltValueNullFieldError.checkNotNull(
              reason, r'FieldError', 'reason'),
          message: message,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
