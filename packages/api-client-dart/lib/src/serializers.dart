//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

// ignore_for_file: unused_import

import 'package:one_of_serializer/any_of_serializer.dart';
import 'package:one_of_serializer/one_of_serializer.dart';
import 'package:built_collection/built_collection.dart';
import 'package:built_value/json_object.dart';
import 'package:built_value/serializer.dart';
import 'package:built_value/standard_json_plugin.dart';
import 'package:built_value/iso_8601_date_time_serializer.dart';
import 'package:dub_api_client/src/date_serializer.dart';
import 'package:dub_api_client/src/model/date.dart';

import 'package:dub_api_client/src/model/bff_home_response.dart';
import 'package:dub_api_client/src/model/error.dart';
import 'package:dub_api_client/src/model/error_error.dart';
import 'package:dub_api_client/src/model/event_summary.dart';
import 'package:dub_api_client/src/model/field_error.dart';
import 'package:dub_api_client/src/model/gateway_health200_response.dart';
import 'package:dub_api_client/src/model/me_response.dart';
import 'package:dub_api_client/src/model/public_inquiry_request.dart';
import 'package:dub_api_client/src/model/public_inquiry_response.dart';
import 'package:dub_api_client/src/model/rate_limit_details.dart';
import 'package:dub_api_client/src/model/upstream_partial_error.dart';
import 'package:dub_api_client/src/model/user_summary.dart';

part 'serializers.g.dart';

@SerializersFor([
  BffHomeResponse,
  Error,
  ErrorError,
  EventSummary,
  FieldError,
  GatewayHealth200Response,
  MeResponse,
  PublicInquiryRequest,
  PublicInquiryResponse,
  RateLimitDetails,
  UpstreamPartialError,
  UserSummary,
])
Serializers serializers = (_$serializers.toBuilder()
      ..addBuilderFactory(
        const FullType(BuiltList, [FullType(EventSummary)]),
        () => ListBuilder<EventSummary>(),
      )
      ..addBuilderFactory(
        const FullType(BuiltList, [FullType(String)]),
        () => ListBuilder<String>(),
      )
      ..addBuilderFactory(
        const FullType(BuiltList, [FullType(UpstreamPartialError)]),
        () => ListBuilder<UpstreamPartialError>(),
      )
      ..add(const OneOfSerializer())
      ..add(const AnyOfSerializer())
      ..add(const DateSerializer())
      ..add(Iso8601DateTimeSerializer())
    ).build();

Serializers standardSerializers =
    (serializers.toBuilder()..addPlugin(StandardJsonPlugin())).build();
