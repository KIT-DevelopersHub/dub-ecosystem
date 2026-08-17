//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'public_inquiry_response.g.dart';

/// PublicInquiryResponse
///
/// Properties:
/// * [accepted] 
@BuiltValue()
abstract class PublicInquiryResponse implements Built<PublicInquiryResponse, PublicInquiryResponseBuilder> {
  @BuiltValueField(wireName: r'accepted')
  bool get accepted;

  PublicInquiryResponse._();

  factory PublicInquiryResponse([void updates(PublicInquiryResponseBuilder b)]) = _$PublicInquiryResponse;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(PublicInquiryResponseBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<PublicInquiryResponse> get serializer => _$PublicInquiryResponseSerializer();
}

class _$PublicInquiryResponseSerializer implements PrimitiveSerializer<PublicInquiryResponse> {
  @override
  final Iterable<Type> types = const [PublicInquiryResponse, _$PublicInquiryResponse];

  @override
  final String wireName = r'PublicInquiryResponse';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    PublicInquiryResponse object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'accepted';
    yield serializers.serialize(
      object.accepted,
      specifiedType: const FullType(bool),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    PublicInquiryResponse object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required PublicInquiryResponseBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'accepted':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(bool),
          ) as bool;
          result.accepted = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  PublicInquiryResponse deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = PublicInquiryResponseBuilder();
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

