//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'upstream_partial_error.g.dart';

/// UpstreamPartialError
///
/// Properties:
/// * [source_] 
/// * [code] 
@BuiltValue()
abstract class UpstreamPartialError implements Built<UpstreamPartialError, UpstreamPartialErrorBuilder> {
  @BuiltValueField(wireName: r'source')
  String get source_;

  @BuiltValueField(wireName: r'code')
  String get code;

  UpstreamPartialError._();

  factory UpstreamPartialError([void updates(UpstreamPartialErrorBuilder b)]) = _$UpstreamPartialError;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(UpstreamPartialErrorBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<UpstreamPartialError> get serializer => _$UpstreamPartialErrorSerializer();
}

class _$UpstreamPartialErrorSerializer implements PrimitiveSerializer<UpstreamPartialError> {
  @override
  final Iterable<Type> types = const [UpstreamPartialError, _$UpstreamPartialError];

  @override
  final String wireName = r'UpstreamPartialError';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    UpstreamPartialError object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'source';
    yield serializers.serialize(
      object.source_,
      specifiedType: const FullType(String),
    );
    yield r'code';
    yield serializers.serialize(
      object.code,
      specifiedType: const FullType(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    UpstreamPartialError object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required UpstreamPartialErrorBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'source':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.source_ = valueDes;
          break;
        case r'code':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.code = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  UpstreamPartialError deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = UpstreamPartialErrorBuilder();
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

