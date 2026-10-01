// @dub/policy-gate — the declarative entry-layer PEP. A service declares ONE table of
// `METHOD /path -> PermissionKey[] | INTERNAL | PUBLIC`, mounts `policyGate` first, and
// performs no other authorization anywhere. Routes absent from the table are denied, and a
// CI test (assertRouteCoverage) fails the build when the two drift.
//
// The three rule forms — and the one distinction worth opening rule.ts for:
//   PermissionKey[]  the caller must hold EVERY key (conjunctive)
//   INTERNAL         service-to-service only: requires the x-dub-internal marker, which
//                    api-gateway strips off every external request, so it cannot be forged
//   PUBLIC           the open internet may call this, deliberately
// The two are NOT interchangeable: a health probe or drain route is INTERNAL, not PUBLIC.
export { PUBLIC, INTERNAL, appLevel, missingKeys, allows, type RouteRule, type RequiredKeys } from "./rule";
export { definePolicyTable, type PolicyTable, type RouteKey, type HttpMethod } from "./table";
export { policyGate, type PolicyGateOptions, type PolicyGateVars, type PermissionGranter } from "./gate";
export { createAuthzGranter, type AuthzGranterOptions } from "./authz";
export { checkRouteCoverage, assertRouteCoverage, type CoverageResult } from "./coverage";
export { routeKey, protectableRouteKeys, matchedRouteKey, type RoutedApp, type RegisteredRoute } from "./routes";
