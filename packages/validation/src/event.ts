// event-service per-event enabled apps validator (event.SaveEventAppsRequest).
// The allowed ids come from @dub/types' app registry (APP_IDS), so a new app is
// accepted the moment it is registered there — no list to keep in sync here.
import { invalidField, FieldCollector } from "./collector";
import { isPlainObject } from "./primitives";
import { event, member, type appRegistry } from "@dub/types";

/** Check an enabled-app list; pushes errors onto `c` and returns the canonical list. */
export function checkEnabledApps(c: FieldCollector, field: string, value: unknown): appRegistry.AppId[] | null {
  if (!Array.isArray(value)) {
    c.add(field, "invalid_type", `${field} must be an array of app ids`);
    return null;
  }
  let ok = true;
  value.forEach((v, i) => {
    if (!event.isEnabledAppList([v])) {
      c.add(`${field}[${i}]`, "invalid_enum", "unknown app id");
      ok = false;
    }
  });
  return ok ? event.resolveEnabledApps(value as string[]) : null;
}

/** Validate a SaveEventAppsRequest. Throws VALIDATION_FAILED; returns the canonical set. */
export function validateSaveEventAppsRequest(body: unknown): event.SaveEventAppsRequest {
  if (!isPlainObject(body)) throw invalidField("(root)", "invalid_type");
  const c = new FieldCollector();
  const apps = checkEnabledApps(c, "enabledApps", body.enabledApps);
  c.throwIfInvalid();
  return { enabledApps: apps ?? [] };
}

/** Optional event scope (`?eventId=` / body `eventId`): absent/null/"" => undefined. */
export function checkEventScopeId(c: FieldCollector, field: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!member.isEventScopeId(value)) {
    c.add(field, "invalid_format", "invalid event id");
    return undefined;
  }
  return value;
}

/** Parse an optional event scope; throws VALIDATION_FAILED on a malformed id. */
export function parseEventScopeId(value: unknown, field = "eventId"): string | undefined {
  const c = new FieldCollector();
  const id = checkEventScopeId(c, field, value);
  c.throwIfInvalid();
  return id;
}
