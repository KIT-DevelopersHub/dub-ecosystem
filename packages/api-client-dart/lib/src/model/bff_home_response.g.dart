// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'bff_home_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$BffHomeResponse extends BffHomeResponse {
  @override
  final BuiltList<EventSummary> upcomingEvents;
  @override
  final int unreadCount;
  @override
  final BuiltList<UpstreamPartialError> partialErrors;

  factory _$BffHomeResponse([void Function(BffHomeResponseBuilder)? updates]) =>
      (BffHomeResponseBuilder()..update(updates))._build();

  _$BffHomeResponse._(
      {required this.upcomingEvents,
      required this.unreadCount,
      required this.partialErrors})
      : super._();
  @override
  BffHomeResponse rebuild(void Function(BffHomeResponseBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  BffHomeResponseBuilder toBuilder() => BffHomeResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is BffHomeResponse &&
        upcomingEvents == other.upcomingEvents &&
        unreadCount == other.unreadCount &&
        partialErrors == other.partialErrors;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, upcomingEvents.hashCode);
    _$hash = $jc(_$hash, unreadCount.hashCode);
    _$hash = $jc(_$hash, partialErrors.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'BffHomeResponse')
          ..add('upcomingEvents', upcomingEvents)
          ..add('unreadCount', unreadCount)
          ..add('partialErrors', partialErrors))
        .toString();
  }
}

class BffHomeResponseBuilder
    implements Builder<BffHomeResponse, BffHomeResponseBuilder> {
  _$BffHomeResponse? _$v;

  ListBuilder<EventSummary>? _upcomingEvents;
  ListBuilder<EventSummary> get upcomingEvents =>
      _$this._upcomingEvents ??= ListBuilder<EventSummary>();
  set upcomingEvents(ListBuilder<EventSummary>? upcomingEvents) =>
      _$this._upcomingEvents = upcomingEvents;

  int? _unreadCount;
  int? get unreadCount => _$this._unreadCount;
  set unreadCount(int? unreadCount) => _$this._unreadCount = unreadCount;

  ListBuilder<UpstreamPartialError>? _partialErrors;
  ListBuilder<UpstreamPartialError> get partialErrors =>
      _$this._partialErrors ??= ListBuilder<UpstreamPartialError>();
  set partialErrors(ListBuilder<UpstreamPartialError>? partialErrors) =>
      _$this._partialErrors = partialErrors;

  BffHomeResponseBuilder() {
    BffHomeResponse._defaults(this);
  }

  BffHomeResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _upcomingEvents = $v.upcomingEvents.toBuilder();
      _unreadCount = $v.unreadCount;
      _partialErrors = $v.partialErrors.toBuilder();
      _$v = null;
    }
    return this;
  }

  @override
  void replace(BffHomeResponse other) {
    _$v = other as _$BffHomeResponse;
  }

  @override
  void update(void Function(BffHomeResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  BffHomeResponse build() => _build();

  _$BffHomeResponse _build() {
    _$BffHomeResponse _$result;
    try {
      _$result = _$v ??
          _$BffHomeResponse._(
            upcomingEvents: upcomingEvents.build(),
            unreadCount: BuiltValueNullFieldError.checkNotNull(
                unreadCount, r'BffHomeResponse', 'unreadCount'),
            partialErrors: partialErrors.build(),
          );
    } catch (_) {
      late String _$failedField;
      try {
        _$failedField = 'upcomingEvents';
        upcomingEvents.build();

        _$failedField = 'partialErrors';
        partialErrors.build();
      } catch (e) {
        throw BuiltValueNestedFieldError(
            r'BffHomeResponse', _$failedField, e.toString());
      }
      rethrow;
    }
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
