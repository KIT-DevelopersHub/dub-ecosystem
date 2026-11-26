// The ONE origin a Service-Binding caller uses, and the ONE check a worker that also
// serves a public workers.dev subdomain uses to tell binding traffic from internet traffic.
// Service Bindings ignore the host for routing, so the host is free to carry this marker;
// a public request carries the real subdomain host and cannot forge "svc". Callers
// (createServiceClient, freeq-drain) and gates (gantt/notification entry) both read these,
// so they can no longer disagree (#836: freeq-drain sent host "gantt-service" -> 404).
export const SERVICE_BINDING_HOST = "svc";
export const SERVICE_BINDING_ORIGIN = `https://${SERVICE_BINDING_HOST}`;

/** True when the request arrived over a Service Binding (host "svc"). */
export function isServiceBindingRequest(url: URL | string): boolean {
  return (typeof url === "string" ? new URL(url) : url).hostname === SERVICE_BINDING_HOST;
}
