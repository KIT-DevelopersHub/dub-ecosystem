// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'public_inquiry_response.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

class _$PublicInquiryResponse extends PublicInquiryResponse {
  @override
  final bool accepted;

  factory _$PublicInquiryResponse(
          [void Function(PublicInquiryResponseBuilder)? updates]) =>
      (PublicInquiryResponseBuilder()..update(updates))._build();

  _$PublicInquiryResponse._({required this.accepted}) : super._();
  @override
  PublicInquiryResponse rebuild(
          void Function(PublicInquiryResponseBuilder) updates) =>
      (toBuilder()..update(updates)).build();

  @override
  PublicInquiryResponseBuilder toBuilder() =>
      PublicInquiryResponseBuilder()..replace(this);

  @override
  bool operator ==(Object other) {
    if (identical(other, this)) return true;
    return other is PublicInquiryResponse && accepted == other.accepted;
  }

  @override
  int get hashCode {
    var _$hash = 0;
    _$hash = $jc(_$hash, accepted.hashCode);
    _$hash = $jf(_$hash);
    return _$hash;
  }

  @override
  String toString() {
    return (newBuiltValueToStringHelper(r'PublicInquiryResponse')
          ..add('accepted', accepted))
        .toString();
  }
}

class PublicInquiryResponseBuilder
    implements Builder<PublicInquiryResponse, PublicInquiryResponseBuilder> {
  _$PublicInquiryResponse? _$v;

  bool? _accepted;
  bool? get accepted => _$this._accepted;
  set accepted(bool? accepted) => _$this._accepted = accepted;

  PublicInquiryResponseBuilder() {
    PublicInquiryResponse._defaults(this);
  }

  PublicInquiryResponseBuilder get _$this {
    final $v = _$v;
    if ($v != null) {
      _accepted = $v.accepted;
      _$v = null;
    }
    return this;
  }

  @override
  void replace(PublicInquiryResponse other) {
    _$v = other as _$PublicInquiryResponse;
  }

  @override
  void update(void Function(PublicInquiryResponseBuilder)? updates) {
    if (updates != null) updates(this);
  }

  @override
  PublicInquiryResponse build() => _build();

  _$PublicInquiryResponse _build() {
    final _$result = _$v ??
        _$PublicInquiryResponse._(
          accepted: BuiltValueNullFieldError.checkNotNull(
              accepted, r'PublicInquiryResponse', 'accepted'),
        );
    replace(_$result);
    return _$result;
  }
}

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
