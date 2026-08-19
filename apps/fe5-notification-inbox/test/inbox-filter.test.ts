import { describe, expect, it } from "vitest";
import {
  parseInboxFilter,
  serializeInboxFilter,
  toInboxQuery,
} from "../src/lib/inbox-filter";

describe("inbox filter URL sync", () => {
  it("parses unread + category + type from a query string", () => {
    expect(parseInboxFilter("?unread=1&cat=mail&type=task.")).toEqual({
      unreadOnly: true,
      category: "mail",
      type: "task.",
    });
    expect(parseInboxFilter("")).toEqual({ unreadOnly: false, category: "all", type: "" });
  });

  it("falls back to 'all' for an unknown category value", () => {
    expect(parseInboxFilter("?cat=bogus").category).toBe("all");
    expect(parseInboxFilter("?cat=participation").category).toBe("participation");
  });

  it("serializes only non-default values", () => {
    expect(serializeInboxFilter({ unreadOnly: false, category: "all", type: "" }).toString()).toBe("");
    expect(
      serializeInboxFilter({ unreadOnly: true, category: "app_update", type: "" }).toString(),
    ).toBe("unread=1&cat=app_update");
  });

  it("round-trips", () => {
    const f = { unreadOnly: true, category: "participation" as const, type: "" };
    expect(parseInboxFilter(serializeInboxFilter(f))).toEqual(f);
  });

  it("builds the api query, omitting empty fields and adding cursor/limit (category is client-side)", () => {
    expect(toInboxQuery({ unreadOnly: false, type: "" }, { limit: 50 })).toEqual({ limit: 50 });
    expect(toInboxQuery({ unreadOnly: true, type: "task." }, { cursor: "50", limit: 50 })).toEqual({
      unreadOnly: true,
      type: "task.",
      cursor: "50",
      limit: 50,
    });
  });
});
