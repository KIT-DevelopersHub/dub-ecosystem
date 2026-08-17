// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'event_summary.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const EventSummaryPhaseEnum _$eventSummaryPhaseEnum_planning =
    const EventSummaryPhaseEnum._('planning');
const EventSummaryPhaseEnum _$eventSummaryPhaseEnum_preparing =
    const EventSummaryPhaseEnum._('preparing');
const EventSummaryPhaseEnum _$eventSummaryPhaseEnum_open =
    const EventSummaryPhaseEnum._('open');
const EventSummaryPhaseEnum _$eventSummaryPhaseEnum_live =
    const EventSummaryPhaseEnum._('live');
const EventSummaryPhaseEnum _$eventSummaryPhaseEnum_wrapup =
    const EventSummaryPhaseEnum._('wrapup');
const EventSummaryPhaseEnum _$eventSummaryPhaseEnum_closed =
    const EventSummaryPhaseEnum._('closed');

EventSummaryPhaseEnum _$eventSummaryPhaseEnumValueOf(String name) {
  switch (name) {
    case 'planning':
      return _$eventSummaryPhaseEnum_planning;
    case 'preparing':
      return _$eventSummaryPhaseEnum_preparing;
    case 'open':
      return _$eventSummaryPhaseEnum_open;
    case 'live':
      return _$eventSummaryPhaseEnum_live;
    case 'wrapup':
      return _$eventSummaryPhaseEnum_wrapup;
    case 'closed':
      return _$eventSummaryPhaseEnum_closed;
    default:
      throw ArgumentError(name);
  }
}

final BuiltSet<EventSummaryPhaseEnum> _$eventSummaryPhaseEnumValues =
    BuiltSet<EventSummaryPhaseEnum>(const <EventSummaryPhaseEnum>[
  _$eventSummaryPhaseEnum_planning,
  _$eventSummaryPhaseEnum_preparing,
  _$eventSummaryPhaseEnum_open,
  _$eventSummaryPhaseEnum_live,
  _$eventSummaryPhaseEnum_wrapup,
  _$eventSummaryPhaseEnum_closed,
]);

Serializer<EventSummaryPhaseEnum> _$eventSummaryPhaseEnumSerializer =
    _$EventSummaryPhaseEnumSerializer();

class _$EventSummaryPhaseEnumSerializer
    implements PrimitiveSerializer<EventSummaryPhaseEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'planning': 'planning',
    'preparing': 'preparing',
    'open': 'open',
    'live': 'live',
    'wrapup': 'wrapup',
    'closed': 'closed',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'planning': 'planning',
    'preparing': 'preparing',
    'open': 'open',
    'live': 'live',
    'wrapup': 'wrapup',
    'closed': 'closed',
  };

  @override
  final Iterable<Type> types = const <Type>[EventSummaryPhaseEnum];
  @override
  final String wireName = 'EventSummaryPhaseEnum';

  @override
  Object serialize(Serializers serializers, EventSummaryPhaseEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  EventSummaryPhaseEnum deserialize(Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      EventSummaryPhaseEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$EventSummary extends EventSummary {
  @override
  final String id;
  @override
  final String title;
  @override
  final EventSummaryPhaseEnum phase;
  @override
  final DateTime? startsAt;

  factory _$EventSummary([void Function(EventSummaryBuilder)? updates]) =>
      (EventSummaryBuilder()..update(updates))._build();

  _$EventSummary._(
      {required this.id,
      required this.title,
      required this.phase,
      this.startsAt})
      : super._();
  @override
  EventSummary rebuild(void Function(EventSummaryBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  EventSummaryBuilder toBuilder() => EventSummaryBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is EventSummary &&
        id == other.id &&
        title == other.title &&
        phase == other.phase &&
        startsAt == other.startsAt;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, id.hashCode);
    _$hash = $jc(_$hash, title.hashCode);
    _$hash = $jc(_$hash, phase.hashCode);
    _$hash = $jc(_$hash, startsAt.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'EventSummary')
          ..add('id', id)
          ..add('title', title)
          ..add('phase', phase)
          ..add('startsAt', startsAt))
        .toString();
  }
}

class EventSummaryBuilder
    implements Builder<EventSummary, EventSummaryBuilder> {
  _$EventSummary? _$v;

  String? _id;
  String? get id => _$this._id;
  set id(String? id) => _$this._id = id;

  String? _title;
  String? get title => _$this._title;
  set title(String? title) => _$this._title = title;

  EventSummaryPhaseEnum? _phase;
  EventSummaryPhaseEnum? get phase => _$this._phase;
  set phase(EventSummaryPhaseEnum? phase) => _$this._phase = phase;

  DateTime? _startsAt;
  DateTime? get startsAt => _$this._startsAt;
  set startsAt(DateTime? startsAt) => _$this._startsAt = startsAt;

  EventSummaryBuilder() {
    EventSummary._defaults(this);
  }

  EventSummaryBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _id = $v.id;
      _title = $v.title;
      _phase = $v.phase;
      _startsAt = $v.startsAt;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(EventSummary other) {
    _$v = other as _$EventSummary;
  }

  @override
  void update(void Function(EventSummaryBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  EventSummary build() => _build();

  _$EventSummary _build() {
    final _$result = _$v ??
        _$EventSummary._(
          id: BuiltValueNullFieldError.checkNotNull(id, r'EventSummary', 'id'),
          title: BuiltValueNullFieldError.checkNotNull(
              title, r'EventSummary', 'title'),
          phase: BuiltValueNullFieldError.checkNotNull(
              phase, r'EventSummary', 'phase'),
          startsAt: startsAt,
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
