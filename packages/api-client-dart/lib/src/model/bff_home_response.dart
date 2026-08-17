//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:dub_api_client/src/model/event_summary.dart';
import 'package:dub_api_client/src/model/upstream_partial_error.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'bff_home_response.g.dart';

/// BFF aggregation tolerates partial upstream failure (partialErrors lists the degraded sources).
///
/// Properties:
/// * [upcomingEvents] 
/// * [unreadCount] 
/// * [partialErrors] 
@BuiltValue()
abstract class BffHomeResponse implements Built<BffHomeResponse, BffHomeResponseBuilder> {
  @BuiltValueField(wireName: r'upcomingEvents')
  BuiltList<EventSummary> get upcomingEvents;

  @BuiltValueField(wireName: r'unreadCount')
  int get unreadCount;

  @BuiltValueField(wireName: r'partialErrors')
  BuiltList<UpstreamPartialError> get partialErrors;

  BffHomeResponse._();

  factory BffHomeResponse([void updates(BffHomeResponseBuilder b)]) = _$BffHomeResponse;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(BffHomeResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<BffHomeResponse> get serializer => _$BffHomeResponseSerializer();
}

class _$BffHomeResponseSerializer implements PrimitiveSerializer<BffHomeResponse> {
  @override
  final Iterable<Type> types = const [BffHomeResponse, _$BffHomeResponse];

  @override
  final String wireName = r'BffHomeResponse';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    BffHomeResponse object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'upcomingEvents';
    yield serializers.serialize(
      object.upcomingEvents,
      specifiedType: const FullType(BuiltList, [FullType(EventSummary)]),
    );
    yield r'unreadCount';
    yield serializers.serialize(
      object.unreadCount,
      specifiedType: const FullType(int),
    );
    yield r'partialErrors';
    yield serializers.serialize(
      object.partialErrors,
      specifiedType: const FullType(BuiltList, [FullType(UpstreamPartialError)]),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    BffHomeResponse object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required BffHomeResponseBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'upcomingEvents':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(EventSummary)]),
          ) as BuiltList<EventSummary>;
          result.upcomingEvents.replace(valueDes);
          break;
        case r'unreadCount':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.unreadCount = valueDes;
          break;
        case r'partialErrors':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(BuiltList, [FullType(UpstreamPartialError)]),
          ) as BuiltList<UpstreamPartialError>;
          result.partialErrors.replace(valueDes);
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  BffHomeResponse deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = BffHomeResponseBuilder();
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

