//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'rate_limit_details.g.dart';

/// RateLimitDetails
///
/// Properties:
/// * [retryAfterSec] 
@BuiltValue()
abstract class RateLimitDetails implements Built<RateLimitDetails, RateLimitDetailsBuilder> {
  @BuiltValueField(wireName: r'retryAfterSec')
  int get retryAfterSec;

  RateLimitDetails._();

  factory RateLimitDetails([void updates(RateLimitDetailsBuilder b)]) = _$RateLimitDetails;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(RateLimitDetailsBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<RateLimitDetails> get serializer => _$RateLimitDetailsSerializer();
}

class _$RateLimitDetailsSerializer implements PrimitiveSerializer<RateLimitDetails> {
  @override
  final Iterable<Type> types = const [RateLimitDetails, _$RateLimitDetails];

  @override
  final String wireName = r'RateLimitDetails';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    RateLimitDetails object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'retryAfterSec';
    yield serializers.serialize(
      object.retryAfterSec,
      specifiedType: const FullType(int),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    RateLimitDetails object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required RateLimitDetailsBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'retryAfterSec':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(int),
          ) as int;
          result.retryAfterSec = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  RateLimitDetails deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = RateLimitDetailsBuilder();
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

