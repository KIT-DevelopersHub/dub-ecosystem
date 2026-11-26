import { describe, it, expect } from "vitest";
import { isDubError, CommonErrorCodes, type FieldError } from "@dub/errors";
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
  it("canonicalizes: launcher order, de-duplicated, イベント always on", () => {
    expect(validateSaveEventAppsRequest({ enabledApps: ["admin", "gantt", "gantt"] })).toEqual({
      enabledApps: ["events", "gantt", "admin"],
    });
  });

  it("accepts an empty list (only the always-on イベント remains)", () => {
    expect(validateSaveEventAppsRequest({ enabledApps: [] })).toEqual({ enabledApps: ["events"] });
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
