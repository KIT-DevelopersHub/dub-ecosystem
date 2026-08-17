// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'public_inquiry_request.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

const PublicInquiryRequestKindEnum _$publicInquiryRequestKindEnum_general =
    const PublicInquiryRequestKindEnum._('general');
const PublicInquiryRequestKindEnum _$publicInquiryRequestKindEnum_sponsor =
    const PublicInquiryRequestKindEnum._('sponsor');
const PublicInquiryRequestKindEnum _$publicInquiryRequestKindEnum_press =
    const PublicInquiryRequestKindEnum._('press');

PublicInquiryRequestKindEnum _$publicInquiryRequestKindEnumValueOf(
    String name) {
  switch (name) {
    case 'general':
      return _$publicInquiryRequestKindEnum_general;
    case 'sponsor':
      return _$publicInquiryRequestKindEnum_sponsor;
    case 'press':
      return _$publicInquiryRequestKindEnum_press;
    default:
      throw ArgumentError(name);
  }
}

final BuiltSet<PublicInquiryRequestKindEnum>
    _$publicInquiryRequestKindEnumValues =
    BuiltSet<PublicInquiryRequestKindEnum>(const <PublicInquiryRequestKindEnum>[
  _$publicInquiryRequestKindEnum_general,
  _$publicInquiryRequestKindEnum_sponsor,
  _$publicInquiryRequestKindEnum_press,
]);

Serializer<PublicInquiryRequestKindEnum>
    _$publicInquiryRequestKindEnumSerializer =
    _$PublicInquiryRequestKindEnumSerializer();

class _$PublicInquiryRequestKindEnumSerializer
    implements PrimitiveSerializer<PublicInquiryRequestKindEnum> {
  static const Map<String, Object> _toWire = const <String, Object>{
    'general': 'general',
    'sponsor': 'sponsor',
    'press': 'press',
  };
  static const Map<Object, String> _fromWire = const <Object, String>{
    'general': 'general',
    'sponsor': 'sponsor',
    'press': 'press',
  };

  @override
  final Iterable<Type> types = const <Type>[PublicInquiryRequestKindEnum];
  @override
  final String wireName = 'PublicInquiryRequestKindEnum';

  @override
  Object serialize(Serializers serializers, PublicInquiryRequestKindEnum object,
          {FullType specifiedType = FullType.unspecified}) =>
      _toWire[object.name] ?? object.name;

  @override
  PublicInquiryRequestKindEnum deserialize(
          Serializers serializers, Object serialized,
          {FullType specifiedType = FullType.unspecified}) =>
      PublicInquiryRequestKindEnum.valueOf(
          _fromWire[serialized] ?? (serialized is String ? serialized : ''));
}

class _$PublicInquiryRequest extends PublicInquiryRequest {
  @override
  final PublicInquiryRequestKindEnum kind;
  @override
  final String name;
  @override
  final String email;
  @override
  final String message;
  @override
  final String turnstileToken;

  factory _$PublicInquiryRequest(
          [void Function(PublicInquiryRequestBuilder)? updates]) =>
      (PublicInquiryRequestBuilder()..update(updates))._build();

  _$PublicInquiryRequest._(
      {required this.kind,
      required this.name,
      required this.email,
      required this.message,
      required this.turnstileToken})
      : super._();
  @override
  PublicInquiryRequest rebuild(
          void Function(PublicInquiryRequestBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  PublicInquiryRequestBuilder toBuilder() =>
      PublicInquiryRequestBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is PublicInquiryRequest &&
        kind == other.kind &&
        name == other.name &&
        email == other.email &&
        message == other.message &&
        turnstileToken == other.turnstileToken;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, kind.hashCode);
    _$hash = $jc(_$hash, name.hashCode);
    _$hash = $jc(_$hash, email.hashCode);
    _$hash = $jc(_$hash, message.hashCode);
    _$hash = $jc(_$hash, turnstileToken.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'PublicInquiryRequest')
          ..add('kind', kind)
          ..add('name', name)
          ..add('email', email)
          ..add('message', message)
          ..add('turnstileToken', turnstileToken))
        .toString();
  }
}

class PublicInquiryRequestBuilder
    implements Builder<PublicInquiryRequest, PublicInquiryRequestBuilder> {
  _$PublicInquiryRequest? _$v;

  PublicInquiryRequestKindEnum? _kind;
  PublicInquiryRequestKindEnum? get kind => _$this._kind;
  set kind(PublicInquiryRequestKindEnum? kind) => _$this._kind = kind;

  String? _name;
  String? get name => _$this._name;
  set name(String? name) => _$this._name = name;

  String? _email;
  String? get email => _$this._email;
  set email(String? email) => _$this._email = email;

  String? _message;
  String? get message => _$this._message;
  set message(String? message) => _$this._message = message;

  String? _turnstileToken;
  String? get turnstileToken => _$this._turnstileToken;
  set turnstileToken(String? turnstileToken) =>
      _$this._turnstileToken = turnstileToken;

  PublicInquiryRequestBuilder() {
    PublicInquiryRequest._defaults(this);
  }

  PublicInquiryRequestBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _kind = $v.kind;
      _name = $v.name;
      _email = $v.email;
      _message = $v.message;
      _turnstileToken = $v.turnstileToken;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(PublicInquiryRequest other) {
    _$v = other as _$PublicInquiryRequest;
  }

  @override
  void update(void Function(PublicInquiryRequestBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  PublicInquiryRequest build() => _build();

  _$PublicInquiryRequest _build() {
    final _$result = _$v ??
        _$PublicInquiryRequest._(
          kind: BuiltValueNullFieldError.checkNotNull(
              kind, r'PublicInquiryRequest', 'kind'),
          name: BuiltValueNullFieldError.checkNotNull(
              name, r'PublicInquiryRequest', 'name'),
          email: BuiltValueNullFieldError.checkNotNull(
              email, r'PublicInquiryRequest', 'email'),
          message: BuiltValueNullFieldError.checkNotNull(
              message, r'PublicInquiryRequest', 'message'),
          turnstileToken: BuiltValueNullFieldError.checkNotNull(
              turnstileToken, r'PublicInquiryRequest', 'turnstileToken'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
