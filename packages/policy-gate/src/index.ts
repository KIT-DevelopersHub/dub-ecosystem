// @dub/policy-gate — the declarative entry-layer PEP. A service declares ONE table of
// `METHOD /path -> rule`, mounts `policyGate` first, and performs no other authorization
// anywhere. Routes absent from the table are denied, and a CI test (assertRouteCoverage)
// fails the build when the two drift.
//
// The five rule forms — the vocabulary is closed; open rule.ts before reaching for any of
// the last four, each has a "when this is WRONG" note:
//   PUBLIC                   the open internet may call this, deliberately
//   AUTHENTICATED            any signed-in user, no key — ONLY for self-scoped routes whose
//                            subject is the session itself (`/me`), never "let's be lenient"
//   INTERNAL                 service-to-service only: requires the x-dub-internal marker,
//                            which api-gateway strips off every external request, so it
//                            cannot be forged. No key demanded, none granted
//   PermissionKey[]          the caller must hold EVERY key (conjunctive; see `appLevel`)
//   internalWithKeys([...])  both at once: the marker AND every key
// None are interchangeable: a health probe or drain route is INTERNAL, not PUBLIC; a `/me`
// route is AUTHENTICATED, not PUBLIC (PUBLIC does not even set `userId`); an internal route
// that demands a key is `internalWithKeys`, not one of the two halves.
export {
  PUBLIC,
  AUTHENTICATED,
  INTERNAL,
  internalWithKeys,
  isInternalWithKeys,
  requiredKeysOf,
  appLevel,
  missingKeys,
  allows,
  type RouteRule,
  type RequiredKeys,
  type InternalWithKeys,
} from "./rule";
export { definePolicyTable, type PolicyTable, type RouteKey, type HttpMethod } from "./table";
export { policyGate, type PolicyGateOptions, type PolicyGateVars, type PermissionGranter } from "./gate";
export { createAuthzGranter, type AuthzGranterOptions } from "./authz";
export { checkRouteCoverage, assertRouteCoverage, type CoverageResult } from "./coverage";
export { routeKey, protectableRouteKeys, matchedRouteKey, type RoutedApp, type RegisteredRoute } from "./routes";
