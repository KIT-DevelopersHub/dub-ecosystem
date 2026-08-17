//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_element
import 'package:built_collection/built_collection.dart';
import 'package:built_value/built_value.dart';
import 'package:built_value/serializer.dart';

part 'public_inquiry_request.g.dart';

/// PublicInquiryRequest
///
/// Properties:
/// * [kind] 
/// * [name] 
/// * [email] 
/// * [message] 
/// * [turnstileToken] 
@BuiltValue()
abstract class PublicInquiryRequest implements Built<PublicInquiryRequest, PublicInquiryRequestBuilder> {
  @BuiltValueField(wireName: r'kind')
  PublicInquiryRequestKindEnum get kind;
  // enum kindEnum {  general,  sponsor,  press,  };

  @BuiltValueField(wireName: r'name')
  String get name;

  @BuiltValueField(wireName: r'email')
  String get email;

  @BuiltValueField(wireName: r'message')
  String get message;

  @BuiltValueField(wireName: r'turnstileToken')
  String get turnstileToken;

  PublicInquiryRequest._();

  factory PublicInquiryRequest([void updates(PublicInquiryRequestBuilder b)]) = _$PublicInquiryRequest;

  @BuiltValueHook(initializeBuilder: true)
  static void _defaults(PublicInquiryRequestBuilder b) => b;

  @BuiltValueSerializer(custom: true)
  static Serializer<PublicInquiryRequest> get serializer => _$PublicInquiryRequestSerializer();
}

class _$PublicInquiryRequestSerializer implements PrimitiveSerializer<PublicInquiryRequest> {
  @override
  final Iterable<Type> types = const [PublicInquiryRequest, _$PublicInquiryRequest];

  @override
  final String wireName = r'PublicInquiryRequest';

  Iterable<Object?> _serializeProperties(
    Serializers serializers,
    PublicInquiryRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) sync* {
    yield r'kind';
    yield serializers.serialize(
      object.kind,
      specifiedType: const FullType(PublicInquiryRequestKindEnum),
    );
    yield r'name';
    yield serializers.serialize(
      object.name,
      specifiedType: const FullType(String),
    );
    yield r'email';
    yield serializers.serialize(
      object.email,
      specifiedType: const FullType(String),
    );
    yield r'message';
    yield serializers.serialize(
      object.message,
      specifiedType: const FullType(String),
    );
    yield r'turnstileToken';
    yield serializers.serialize(
      object.turnstileToken,
      specifiedType: const FullType(String),
    );
  }

  @override
  Object serialize(
    Serializers serializers,
    PublicInquiryRequest object, {
    FullType specifiedType = FullType.unspecified,
  }) {
    return _serializeProperties(serializers, object, specifiedType: specifiedType).toList();
  }

  void _deserializeProperties(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
    required List<Object?> serializedList,
    required PublicInquiryRequestBuilder result,
    required List<Object?> unhandled,
  }) {
    for (var i = 0; i < serializedList.length; i += 2) {
      final key = serializedList[i] as String;
      final value = serializedList[i + 1];
      switch (key) {
        case r'kind':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(PublicInquiryRequestKindEnum),
          ) as PublicInquiryRequestKindEnum;
          result.kind = valueDes;
          break;
        case r'name':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.name = valueDes;
          break;
        case r'email':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.email = valueDes;
          break;
        case r'message':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.message = valueDes;
          break;
        case r'turnstileToken':
          final valueDes = serializers.deserialize(
            value,
            specifiedType: const FullType(String),
          ) as String;
          result.turnstileToken = valueDes;
          break;
        default:
          unhandled.add(key);
          unhandled.add(value);
          break;
      }
    }
  }

  @override
  PublicInquiryRequest deserialize(
    Serializers serializers,
    Object serialized, {
    FullType specifiedType = FullType.unspecified,
  }) {
    final result = PublicInquiryRequestBuilder();
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

class PublicInquiryRequestKindEnum extends EnumClass {

  @BuiltValueEnumConst(wireName: r'general')
  static const PublicInquiryRequestKindEnum general = _$publicInquiryRequestKindEnum_general;
  @BuiltValueEnumConst(wireName: r'sponsor')
  static const PublicInquiryRequestKindEnum sponsor = _$publicInquiryRequestKindEnum_sponsor;
  @BuiltValueEnumConst(wireName: r'press')
  static const PublicInquiryRequestKindEnum press = _$publicInquiryRequestKindEnum_press;

  static Serializer<PublicInquiryRequestKindEnum> get serializer => _$publicInquiryRequestKindEnumSerializer;

  const PublicInquiryRequestKindEnum._(String name): super(name);

  static BuiltSet<PublicInquiryRequestKindEnum> get values => _$publicInquiryRequestKindEnumValues;
  static PublicInquiryRequestKindEnum valueOf(String name) => _$publicInquiryRequestKindEnumValueOf(name);
}

