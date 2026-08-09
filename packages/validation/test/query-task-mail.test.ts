import { describe, it, expect } from "vitest";
import { DubError, isDubError, CommonErrorCodes, type FieldError } from "@dub/errors";
import {
  assertPaginatedQuery,
  parseCursorQuery,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  validateCreateTaskRequest,
  validateUpdateTaskRequest,
  validateSendMailRequest,
} from "../src/index";

function catchDub(fn: () => void): DubError {
  try {
    fn();
  } catch (e) {
    if (isDubError(e)) return e;
    throw e;
  }
  throw new Error("expected a DubError to be thrown");
}
const fields = (e: DubError) => (e.details as FieldError[]).map((d) => d.field);

describe("assertPaginatedQuery", () => {
  it("defaults limit to 50 and drops empty cursor", () => {
    expect(assertPaginatedQuery({})).toEqual({ limit: DEFAULT_LIMIT });
    expect(assertPaginatedQuery(undefined)).toEqual({ limit: DEFAULT_LIMIT });
    expect(assertPaginatedQuery({ cursor: "", limit: 10 })).toEqual({ limit: 10 });
    expect(assertPaginatedQuery({ cursor: "abc", limit: 200 })).toEqual({
      cursor: "abc",
      limit: 200,
    });
  });

  it("rejects limit > 200, < 1, non-integer, wrong type", () => {
    expect(catchDub(() => assertPaginatedQuery({ limit: 201 })).code).toBe(
      CommonErrorCodes.VALIDATION_FAILED,
    );
    expect(fields(catchDub(() => assertPaginatedQuery({ limit: 0 })))).toEqual(["limit"]);
    expect(fields(catchDub(() => assertPaginatedQuery({ limit: 1.5 })))).toEqual(["limit"]);
    expect(fields(catchDub(() => assertPaginatedQuery({ cursor: 5 })))).toEqual(["cursor"]);
    expect(catchDub(() => assertPaginatedQuery("nope")).code).toBe(
      CommonErrorCodes.VALIDATION_FAILED,
    );
  });

  it("MAX_LIMIT boundary is inclusive", () => {
    expect(assertPaginatedQuery({ limit: MAX_LIMIT }).limit).toBe(MAX_LIMIT);
  });
});

describe("parseCursorQuery (raw string params)", () => {
  it("parses and defaults", () => {
    expect(parseCursorQuery({})).toEqual({ limit: DEFAULT_LIMIT });
    expect(parseCursorQuery({ cursor: "", limit: "" })).toEqual({ limit: DEFAULT_LIMIT });
    expect(parseCursorQuery({ cursor: "c1", limit: "25" })).toEqual({ cursor: "c1", limit: 25 });
  });

  it("rejects non-numeric / out-of-range limit strings", () => {
    expect(fields(catchDub(() => parseCursorQuery({ limit: "abc" })))).toEqual(["limit"]);
    expect(fields(catchDub(() => parseCursorQuery({ limit: "999" })))).toEqual(["limit"]);
    expect(fields(catchDub(() => parseCursorQuery({ limit: "0" })))).toEqual(["limit"]);
  });
});

describe("validateCreateTaskRequest", () => {
  it("accepts a minimal valid body", () => {
    const body = { eventId: "evt_1", title: "Do the thing" };
    expect(validateCreateTaskRequest(body)).toBe(body);
  });

  it("accepts a full valid body", () => {
    const body = {
      eventId: "evt_1",
      title: "T",
      description: "d",
      priority: "high",
      assigneeId: "usr_1",
      dueAt: "2026-08-09T05:00:00Z",
      origin: "github",
    };
    expect(validateCreateTaskRequest(body)).toBe(body);
  });

  it("collects every failure at once", () => {
    const e = catchDub(() =>
      validateCreateTaskRequest({ title: "", priority: "critical", origin: "x", dueAt: 5 }),
    );
    expect(e.code).toBe(CommonErrorCodes.VALIDATION_FAILED);
    expect(fields(e).sort()).toEqual(["dueAt", "eventId", "origin", "priority", "title"].sort());
  });

  it("rejects a non-object root", () => {
    expect(fields(catchDub(() => validateCreateTaskRequest(null)))).toEqual(["(root)"]);
    expect(fields(catchDub(() => validateCreateTaskRequest([])))).toEqual(["(root)"]);
  });

  it("enforces title max length (200)", () => {
    const e = catchDub(() =>
      validateCreateTaskRequest({ eventId: "e", title: "x".repeat(201) }),
    );
    expect((e.details as FieldError[])[0]).toMatchObject({ field: "title", reason: "too_long" });
  });
});

describe("validateUpdateTaskRequest", () => {
  it("requires version (optimistic lock)", () => {
    expect(fields(catchDub(() => validateUpdateTaskRequest({ title: "x" })))).toContain("version");
  });

  it("accepts explicit null for nullable patch fields", () => {
    const body = { version: 3, description: null, assigneeId: null, dueAt: null, status: "done" };
    expect(validateUpdateTaskRequest(body)).toBe(body);
  });

  it("rejects an invalid status enum", () => {
    expect(fields(catchDub(() => validateUpdateTaskRequest({ version: 1, status: "nope" })))).toEqual(
      ["status"],
    );
  });
});

describe("validateSendMailRequest", () => {
  it("accepts a valid request", () => {
    const body = {
      to: [{ email: "a@b.co", name: "A" }, { email: "c@d.io" }],
      subject: "Hi",
      textBody: "body",
    };
    expect(validateSendMailRequest(body)).toBe(body);
  });

  it("requires a non-empty recipient list", () => {
    expect(fields(catchDub(() => validateSendMailRequest({ to: [], subject: "s", textBody: "t" })))).toEqual(
      ["to"],
    );
    expect(fields(catchDub(() => validateSendMailRequest({ subject: "s", textBody: "t" })))).toEqual(
      ["to"],
    );
  });

  it("reports per-recipient errors with indexed field paths", () => {
    const e = catchDub(() =>
      validateSendMailRequest({
        to: [{ email: "ok@x.co" }, { email: "bad" }, { email: "n@x.co", name: 5 }],
        subject: "s",
        textBody: "t",
      }),
    );
    expect(fields(e)).toEqual(["to[1].email", "to[2].name"]);
  });

  it("requires subject and textBody", () => {
    const e = catchDub(() => validateSendMailRequest({ to: [{ email: "a@b.co" }] }));
    expect(fields(e).sort()).toEqual(["subject", "textBody"]);
  });

  it("allows textBody to be an empty string but not missing", () => {
    const ok = { to: [{ email: "a@b.co" }], subject: "s", textBody: "" };
    expect(validateSendMailRequest(ok)).toBe(ok);
  });
});
