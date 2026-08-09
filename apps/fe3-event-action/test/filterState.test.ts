import { describe, it, expect } from "vitest";
import {
  parseEventListFilter,
  serializeEventListFilter,
  parseActionBoardFilter,
  serializeActionBoardFilter,
} from "../src/lib/filterState";

describe("filter URL sync (test observation #9)", () => {
  it("round-trips event list filter", () => {
    const f = { phase: "open" as const, includeArchived: true };
    const s = serializeEventListFilter(f);
    expect(parseEventListFilter(s)).toEqual(f);
  });

  it("defaults are empty and omitted from the query", () => {
    expect(serializeEventListFilter({ phase: null, includeArchived: false })).toBe("");
    expect(parseEventListFilter("")).toEqual({ phase: null, includeArchived: false });
  });

  it("ignores an invalid phase value", () => {
    expect(parseEventListFilter("phase=bogus").phase).toBeNull();
  });

  it("round-trips action board filter", () => {
    const f = { kind: "task_management", status: null };
    expect(parseActionBoardFilter(serializeActionBoardFilter(f))).toEqual(f);
  });
});
