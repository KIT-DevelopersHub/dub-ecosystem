import { describe, expect, it } from "vitest";
import {
  parseInboxFilter,
  serializeInboxFilter,
  toInboxQuery,
} from "../src/lib/inbox-filter";

describe("inbox filter URL sync", () => {
  it("parses unread + type from a query string (sort defaults to newest)", () => {
    expect(parseInboxFilter("?unread=1&type=task.")).toEqual({
      unreadOnly: true,
      type: "task.",
      sort: "newest",
    });
    expect(parseInboxFilter("")).toEqual({ unreadOnly: false, type: "", sort: "newest" });
    expect(parseInboxFilter("?sort=oldest")).toEqual({
      unreadOnly: false,
      type: "",
      sort: "oldest",
    });
  });

  it("serializes only non-default values", () => {
    expect(serializeInboxFilter({ unreadOnly: false, type: "" }).toString()).toBe("");
    expect(serializeInboxFilter({ unreadOnly: true, type: "event." }).toString()).toBe(
      "unread=1&type=event.",
    );
    // newest is the default and stays out of the URL; oldest is serialized.
    expect(serializeInboxFilter({ unreadOnly: false, type: "", sort: "newest" }).toString()).toBe("");
    expect(serializeInboxFilter({ unreadOnly: false, type: "", sort: "oldest" }).toString()).toBe(
      "sort=oldest",
    );
  });

  it("round-trips", () => {
    const f = { unreadOnly: true, type: "task.", sort: "oldest" as const };
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
    // newest is the implicit default -> omitted; oldest is sent.
    expect(toInboxQuery({ unreadOnly: false, type: "", sort: "newest" }, { limit: 25 })).toEqual({
      limit: 25,
    });
    expect(toInboxQuery({ unreadOnly: false, type: "", sort: "oldest" }, { limit: 25 })).toEqual({
      sort: "oldest",
      limit: 25,
    });
  });
});
