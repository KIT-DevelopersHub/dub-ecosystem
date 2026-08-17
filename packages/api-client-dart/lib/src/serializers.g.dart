// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'serializers.dart';

// **************************************************************************
// BuiltValueGenerator
// **************************************************************************

Serializers _$serializers = (Serializers().toBuilder()
      ..add(BffHomeResponse.serializer)
      ..add(Error.serializer)
      ..add(ErrorError.serializer)
      ..add(EventSummary.serializer)
      ..add(EventSummaryPhaseEnum.serializer)
      ..add(FieldError.serializer)
      ..add(GatewayHealth200Response.serializer)
      ..add(MeResponse.serializer)
      ..add(PublicInquiryRequest.serializer)
      ..add(PublicInquiryRequestKindEnum.serializer)
      ..add(PublicInquiryResponse.serializer)
      ..add(RateLimitDetails.serializer)
      ..add(UpstreamPartialError.serializer)
      ..add(UserSummary.serializer)
      ..addBuilderFactory(
          const FullType(BuiltList, const [const FullType(EventSummary)]),
          () => ListBuilder<EventSummary>())
      ..addBuilderFactory(
          const FullType(
              BuiltList, const [const FullType(UpstreamPartialError)]),
          () => ListBuilder<UpstreamPartialError>())
      ..addBuilderFactory(
          const FullType(BuiltList, const [const FullType(String)]),
          () => ListBuilder<String>()))
    .build();

// ignore_for_file: deprecated_member_use_from_same_package,type=lint
