import { describe, it, expect } from "vitest";
import { isDubError, CommonErrorCodes, type FieldError } from "@dub/errors";
import { event } from "@dub/types";
import { validateSaveEventAppsRequest } from "../src/index";

function fieldsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (!isDubError(e)) throw e;
    expect(e.code).toBe(CommonErrorCodes.VALIDATION_FAILED);
    return (e.details as FieldError[]).map((d) => d.field);
  }
  throw new Error("expected VALIDATION_FAILED");
}

describe("validateSaveEventAppsRequest", () => {
  it("canonicalizes: launcher order, de-duplicated, イベント and org-wide apps always on", () => {
    const { enabledApps } = validateSaveEventAppsRequest({ enabledApps: ["admin", "gantt", "gantt"] });
    expect(enabledApps.filter((a) => event.isEventToggleableApp(a))).toEqual(["events", "gantt", "admin"]);
    expect(enabledApps).toContain("mail");
  });

  it("accepts an empty list (only イベント + org-wide apps remain)", () => {
    const { enabledApps } = validateSaveEventAppsRequest({ enabledApps: [] });
    expect(enabledApps.filter((a) => event.isEventToggleableApp(a))).toEqual(["events"]);
  });

  it("rejects an unknown app id with an indexed field", () => {
    expect(fieldsOf(() => validateSaveEventAppsRequest({ enabledApps: ["gantt", "nope"] }))).toEqual([
      "enabledApps[1]",
    ]);
  });

  it("rejects a missing / non-array body", () => {
    expect(fieldsOf(() => validateSaveEventAppsRequest({}))).toEqual(["enabledApps"]);
    expect(fieldsOf(() => validateSaveEventAppsRequest(null))).toEqual(["(root)"]);
  });
});

describe("parseEventScopeId", () => {
  it("accepts the prod id shapes and treats empty as unscoped", async () => {
    const { parseEventScopeId } = await import("../src/index");
    expect(parseEventScopeId("acd75449-c875-4c13-83d8-2dd8f8ce8a33")).toBe("acd75449-c875-4c13-83d8-2dd8f8ce8a33");
    expect(parseEventScopeId("event_01M8C4ZK8020EFG6KYFT7S5B2N")).toBe("event_01M8C4ZK8020EFG6KYFT7S5B2N");
    expect(parseEventScopeId(undefined)).toBeUndefined();
    expect(parseEventScopeId("")).toBeUndefined();
    expect(fieldsOf(() => parseEventScopeId("a b"))).toEqual(["eventId"]);
    expect(fieldsOf(() => parseEventScopeId(42))).toEqual(["eventId"]);
  });
});
