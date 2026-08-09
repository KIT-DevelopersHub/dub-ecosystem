// @dub/http — internal Service Binding HTTP client + x-dub-* context propagation.
export {
  DUB_HEADERS,
  INTERNAL_MARKER,
  newRequestId,
  extractContext,
  dubContext,
  type RequestContext,
} from "./context";
export {
  createServiceClient,
  retryFetch,
  DubHttpError,
  DubHttpTimeoutError,
  DubHttpUnavailableError,
  type ServiceClient,
  type ServiceClientOptions,
  type CallOptions,
  type RetryPolicy,
  type HttpHooks,
  type HttpHookRequestInfo,
  type HttpHookResponseInfo,
  type HttpHookRetryInfo,
  type DubHttpOwnErrorCode,
} from "./client";
