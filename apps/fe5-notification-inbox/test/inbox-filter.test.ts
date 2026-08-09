import { describe, expect, it } from "vitest";
import {
  parseInboxFilter,
  serializeInboxFilter,
  toInboxQuery,
} from "../src/lib/inbox-filter";

describe("inbox filter URL sync", () => {
  it("parses unread + type from a query string", () => {
    expect(parseInboxFilter("?unread=1&type=task.")).toEqual({ unreadOnly: true, type: "task." });
    expect(parseInboxFilter("")).toEqual({ unreadOnly: false, type: "" });
  });

  it("serializes only non-default values", () => {
    expect(serializeInboxFilter({ unreadOnly: false, type: "" }).toString()).toBe("");
    expect(serializeInboxFilter({ unreadOnly: true, type: "event." }).toString()).toBe(
      "unread=1&type=event.",
    );
  });

  it("round-trips", () => {
    const f = { unreadOnly: true, type: "task." };
    expect(parseInboxFilter(serializeInboxFilter(f))).toEqual(f);
  });

  it("builds the api query, omitting empty fields and adding cursor/limit", () => {
    expect(toInboxQuery({ unreadOnly: false, type: "" }, { limit: 50 })).toEqual({ limit: 50 });
    expect(toInboxQuery({ unreadOnly: true, type: "task." }, { cursor: "50", limit: 50 })).toEqual({
      unreadOnly: true,
      type: "task.",
      cursor: "50",
      limit: 50,
    });
  });
});
