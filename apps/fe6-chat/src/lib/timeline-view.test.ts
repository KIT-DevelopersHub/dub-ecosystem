import { describe, it, expect } from "vitest";
import type { Message } from "../api/contract";
import { dateKey, firstUnreadIndex, needsDateDivider } from "./timeline-view";

const ME = "usr_me";
const OTHER = "usr_other";
function msg(id: string, createdAt: string, authorId = OTHER): Message {
  return {
    id,
    channelId: "chn",
    authorId,
    body: "x",
    threadRootId: null,
    replyCount: 0,
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    version: 1,
    createdAt,
  };
}

describe("date dividers", () => {
  it("dateKey extracts the UTC day", () => {
    expect(dateKey("2026-08-09T23:00:00Z")).toBe("2026-08-09");
  });
  it("needs a divider at index 0 and on day changes", () => {
    const m = [msg("a", "2026-08-09T01:00:00Z"), msg("b", "2026-08-09T02:00:00Z"), msg("c", "2026-08-10T01:00:00Z")];
    expect(needsDateDivider(m, 0)).toBe(true);
    expect(needsDateDivider(m, 1)).toBe(false);
    expect(needsDateDivider(m, 2)).toBe(true);
  });
});

describe("firstUnreadIndex", () => {
  it("returns first other-authored message after lastRead", () => {
    const m = [msg("a", "t", ME), msg("b", "t"), msg("c", "t")];
    expect(firstUnreadIndex(m, "a", ME)).toBe(1);
  });
  it("skips my own messages when nothing read yet", () => {
    const m = [msg("a", "t", ME), msg("b", "t")];
    expect(firstUnreadIndex(m, null, ME)).toBe(1);
  });
  it("returns -1 when everything is read", () => {
    const m = [msg("a", "t"), msg("b", "t")];
    expect(firstUnreadIndex(m, "b", ME)).toBe(-1);
  });
});
