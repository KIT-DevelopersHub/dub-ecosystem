//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'event_summary.g.dart';

/// EventSummary
///
/// Properties:
/// * [id] 
/// * [title] 
/// * [phase] 
/// * [startsAt] 
@BuiltValue()
abstract class EventSummary implements Built<EventSummary, EventSummaryBuilder> {
  @BuiltValueField(wireName: r'id')
  String get id;

  @BuiltValueField(wireName: r'title')
  String get title;

  @BuiltValueField(wireName: r'phase')
  EventSummaryPhaseEnum get phase;
  // enum phaseEnum {  planning,  preparing,  open,  live,  wrapup,  closed,  };

  @BuiltValueField(wireName: r'startsAt')
  DateTime? get startsAt;

  EventSummary._();

  factory EventSummary([void updates(EventSummaryBuilder b)]) = _$EventSummary;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(EventSummaryBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<EventSummary> get serializer => _$EventSummarySerializer();
}

class _$EventSummarySerializer implements PrimitiveSerializer<EventSummary> {
  @override
  final Iterable<Type> types = const [EventSummary, _$EventSummary];

  @override
  final String wireName = r'EventSummary';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    EventSummary object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'id';
    yield serializers.serialize(
      object.id,
      specifiedType: const FullType(String),
    );
    yield r'title';
    yield serializers.serialize(
      object.title,
      specifiedType: const FullType(String),
    );
    yield r'phase';
    yield serializers.serialize(
      object.phase,
      specifiedType: const FullType(EventSummaryPhaseEnum),
    );
    if (object.startsAt != null) {
      yield r'startsAt';
      yield serializers.serialize(
        object.startsAt,
        specifiedType: const FullType.nullable(DateTime),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    EventSummary object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required EventSummaryBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'id':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.id = valueDes;
          break;
        case r'title':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.title = valueDes;
          break;
        case r'phase':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(EventSummaryPhaseEnum),
          ) as EventSummaryPhaseEnum;
          result.phase = valueDes;
          break;
        case r'startsAt':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(DateTime),
          ) as DateTime?;
          if (valueDes == null) continue;
          result.startsAt = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  EventSummary deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = EventSummaryBuilder();
    final serializedList = (serialized as Iterable<Object?>).toList();
    final unhandled = <Object?>[];
    _deserializeProperties(
      serializers,
      serialized,
      specifiedType: specifiedType,
      serializedList: serializedList,
      unhandled: unhandled,
      result: result,
    );
    return result.build();
  }
}

class EventSummaryPhaseEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'planning')
  static const EventSummaryPhaseEnum planning = _$eventSummaryPhaseEnum_planning;
  @BuiltValueEnumConst(wireName: r'preparing')
  static const EventSummaryPhaseEnum preparing = _$eventSummaryPhaseEnum_preparing;
  @BuiltValueEnumConst(wireName: r'open')
  static const EventSummaryPhaseEnum open = _$eventSummaryPhaseEnum_open;
  @BuiltValueEnumConst(wireName: r'live')
  static const EventSummaryPhaseEnum live = _$eventSummaryPhaseEnum_live;
  @BuiltValueEnumConst(wireName: r'wrapup')
  static const EventSummaryPhaseEnum wrapup = _$eventSummaryPhaseEnum_wrapup;
  @BuiltValueEnumConst(wireName: r'closed')
  static const EventSummaryPhaseEnum closed = _$eventSummaryPhaseEnum_closed;

  static Serializer<EventSummaryPhaseEnum> get serializer => _$eventSummaryPhaseEnumSerializer;

  const EventSummaryPhaseEnum._(String name): super(name);

  static BuiltSet<EventSummaryPhaseEnum> get values => _$eventSummaryPhaseEnumValues;
  static EventSummaryPhaseEnum valueOf(String name) => _$eventSummaryPhaseEnumValueOf(name);
}

