# dub_api_client.api.GatewayApi

## Load the API package
```dart
import 'package:dub_api_client/api.dart';
```

All URIs are relative to *https://api.developershub.jp*

Method | HTTP request | Description
------------- | ------------- | -------------
[**createPublicInquiry**](GatewayApi.md#createpublicinquiry) | **POST** /api/v1/public/inquiries | Submit a public contact inquiry
[**getBffHome**](GatewayApi.md#getbffhome) | **GET** /api/v1/bff/home | Home screen aggregate (events + unread)
[**getMe**](GatewayApi.md#getme) | **GET** /api/v1/me | Current user, org, permissions and session expiry


# **createPublicInquiry**
> PublicInquiryResponse createPublicInquiry(publicInquiryRequest)

Submit a public contact inquiry

Unauthenticated public endpoint. Protected by Cloudflare Turnstile (turnstileToken) and IP rate limiting.

### Example
```dart
import 'package:dub_api_client/api.dart';

final api = DubApiClient().getGatewayApi();
final PublicInquiryRequest publicInquiryRequest = ; // PublicInquiryRequest | 

try {
    final response = api.createPublicInquiry(publicInquiryRequest);
    print(response);
} on DioException catch (e) {
    print('Exception when calling GatewayApi->createPublicInquiry: $e\n');
}
```

### Parameters

Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **publicInquiryRequest** | [**PublicInquiryRequest**](PublicInquiryRequest.md)|  | 

### Return type

[**PublicInquiryResponse**](PublicInquiryResponse.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getBffHome**
> BffHomeResponse getBffHome()

Home screen aggregate (events + unread)

Gateway-owned BFF composition across event + notification. Degraded upstreams surface in partialErrors rather than failing the whole response.

### Example
```dart
import 'package:dub_api_client/api.dart';
// TODO Configure API key authorization: gatewayIdentity
//defaultApiClient.getAuthentication<ApiKeyAuth>('gatewayIdentity').apiKey = 'YOUR_API_KEY';
// uncomment below to setup prefix (e.g. Bearer) for API key, if needed
//defaultApiClient.getAuthentication<ApiKeyAuth>('gatewayIdentity').apiKeyPrefix = 'Bearer';
// TODO Configure API key authorization: sessionCookie
//defaultApiClient.getAuthentication<ApiKeyAuth>('sessionCookie').apiKey = 'YOUR_API_KEY';
// uncomment below to setup prefix (e.g. Bearer) for API key, if needed
//defaultApiClient.getAuthentication<ApiKeyAuth>('sessionCookie').apiKeyPrefix = 'Bearer';

final api = DubApiClient().getGatewayApi();

try {
    final response = api.getBffHome();
    print(response);
} on DioException catch (e) {
    print('Exception when calling GatewayApi->getBffHome: $e\n');
}
```

### Parameters
This endpoint does not need any parameter.

### Return type

[**BffHomeResponse**](BffHomeResponse.md)

### Authorization

[gatewayIdentity](../README.md#gatewayIdentity), [sessionCookie](../README.md#sessionCookie)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getMe**
> MeResponse getMe()

Current user, org, permissions and session expiry

Gateway-owned composition (identity + session). Requires an authenticated session.

### Example
```dart
import 'package:dub_api_client/api.dart';
// TODO Configure API key authorization: gatewayIdentity
//defaultApiClient.getAuthentication<ApiKeyAuth>('gatewayIdentity').apiKey = 'YOUR_API_KEY';
// uncomment below to setup prefix (e.g. Bearer) for API key, if needed
//defaultApiClient.getAuthentication<ApiKeyAuth>('gatewayIdentity').apiKeyPrefix = 'Bearer';
// TODO Configure API key authorization: sessionCookie
//defaultApiClient.getAuthentication<ApiKeyAuth>('sessionCookie').apiKey = 'YOUR_API_KEY';
// uncomment below to setup prefix (e.g. Bearer) for API key, if needed
//defaultApiClient.getAuthentication<ApiKeyAuth>('sessionCookie').apiKeyPrefix = 'Bearer';

final api = DubApiClient().getGatewayApi();

try {
    final response = api.getMe();
    print(response);
} on DioException catch (e) {
    print('Exception when calling GatewayApi->getMe: $e\n');
}
```

### Parameters
This endpoint does not need any parameter.

### Return type

[**MeResponse**](MeResponse.md)

### Authorization

[gatewayIdentity](../README.md#gatewayIdentity), [sessionCookie](../README.md#sessionCookie)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

