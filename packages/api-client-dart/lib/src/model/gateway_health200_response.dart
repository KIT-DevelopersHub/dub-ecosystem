//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'gateway_health200_response.g.dart';

/// GatewayHealth200Response
///
/// Properties:
/// * [ok] 
@BuiltValue()
abstract class GatewayHealth200Response implements Built<GatewayHealth200Response, GatewayHealth200ResponseBuilder> {
  @BuiltValueField(wireName: r'ok')
  bool? get ok;

  GatewayHealth200Response._();

  factory GatewayHealth200Response([void updates(GatewayHealth200ResponseBuilder b)]) = _$GatewayHealth200Response;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(GatewayHealth200ResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<GatewayHealth200Response> get serializer => _$GatewayHealth200ResponseSerializer();
}

class _$GatewayHealth200ResponseSerializer implements PrimitiveSerializer<GatewayHealth200Response> {
  @override
  final Iterable<Type> types = const [GatewayHealth200Response, _$GatewayHealth200Response];

  @override
  final String wireName = r'GatewayHealth200Response';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    GatewayHealth200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    if (object.ok != null) {
      yield r'ok';
      yield serializers.serialize(
        object.ok,
        specifiedType: const FullType(bool),
      );
    }
  }

  @override
  Object serialize(
    Serializers serializers,
    GatewayHealth200Response object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required GatewayHealth200ResponseBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'ok':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType.nullable(bool),
          ) as bool?;
          if (valueDes == null) continue;
          result.ok = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  GatewayHealth200Response deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = GatewayHealth200ResponseBuilder();
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

