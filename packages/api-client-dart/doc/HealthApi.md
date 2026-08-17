# dub_api_client.api.HealthApi

## Load the API package
```dart
import 'package:dub_api_client/api.dart';
```

All URIs are relative to *https://api.developershub.jp*

Method | HTTP request | Description
------------- | ------------- | -------------
[**gatewayHealth**](HealthApi.md#gatewayhealth) | **GET** /healthz | Gateway liveness probe


# **gatewayHealth**
> GatewayHealth200Response gatewayHealth()

Gateway liveness probe

### Example
```dart
import 'package:dub_api_client/api.dart';

final api = DubApiClient().getHealthApi();

try {
    final response = api.gatewayHealth();
    print(response);
} on DioException catch (e) {
    print('Exception when calling HealthApi->gatewayHealth: $e\n');
}
```

### Parameters
This endpoint does not need any parameter.

### Return type

[**GatewayHealth200Response**](GatewayHealth200Response.md)

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

