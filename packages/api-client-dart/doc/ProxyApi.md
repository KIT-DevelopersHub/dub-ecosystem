# dub_api_client.api.ProxyApi

## Load the API package
```dart
import 'package:dub_api_client/api.dart';
```

All URIs are relative to *https://api.developershub.jp*

Method | HTTP request | Description
------------- | ------------- | -------------
[**proxyRequest**](ProxyApi.md#proxyrequest) | **GET** /api/v1/{segment}/{path} | Transparent proxy to a backing service


# **proxyRequest**
> proxyRequest(segment, path)

Transparent proxy to a backing service

Catch-all for every /api/v1/<segment>/_* request the gateway does not own itself. Applies to all HTTP methods (GET/POST/PUT/PATCH/DELETE) — one operation documents the shared behaviour. Resolves the route, applies guards (WebSocket-upgrade rejected as 400, body cap, internal-only sub-paths 404'd), runs a one-shot session verify for auth:required segments, then forwards with x-dub-request-id + x-dub-user-id. Per-service request/response schemas live in that service's own spec. See each <service>.yaml.

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

final api = DubApiClient().getProxyApi();
final String segment = segment_example; // String | First path segment selecting the backing service: auth, identity, events, actions, tasks, gantt, notifications, files, drive, chat, mail, deploy, github, audit, webhooks.
final String path = path_example; // String | Remaining sub-path, forwarded verbatim to the service after stripping the /api/v1 prefix.

try {
    api.proxyRequest(segment, path);
} on DioException catch (e) {
    print('Exception when calling ProxyApi->proxyRequest: $e\n');
}
```

### Parameters

Name | Type | Description  | Notes
------------- | ------------- | ------------- | -------------
 **segment** | **String**| First path segment selecting the backing service: auth, identity, events, actions, tasks, gantt, notifications, files, drive, chat, mail, deploy, github, audit, webhooks. | 
 **path** | **String**| Remaining sub-path, forwarded verbatim to the service after stripping the /api/v1 prefix. | 

### Return type

void (empty response body)

### Authorization

[gatewayIdentity](../README.md#gatewayIdentity), [sessionCookie](../README.md#sessionCookie)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

