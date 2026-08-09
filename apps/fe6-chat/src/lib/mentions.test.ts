import { describe, it, expect } from "vitest";
import { applyMention, detectMentionTrigger, extractMentions, isMentioned } from "./mentions";

describe("extractMentions", () => {
  it("returns unique userIds in first-seen order", () => {
    expect(extractMentions("hi <@usr_a> and <@usr_b> and <@usr_a>")).toEqual(["usr_a", "usr_b"]);
  });
  it("isMentioned matches the specific user", () => {
    expect(isMentioned("<@usr_a>", "usr_a")).toBe(true);
    expect(isMentioned("<@usr_a>", "usr_b")).toBe(false);
  });
});

describe("detectMentionTrigger", () => {
  it("detects an in-progress mention at the caret", () => {
    const text = "hello @jo";
    const trig = detectMentionTrigger(text, text.length);
    expect(trig).toEqual({ query: "jo", start: 6 });
  });
  it("returns null when a space closed the trigger", () => {
    expect(detectMentionTrigger("hello @jo done", "hello @jo done".length)).toBeNull();
  });
  it("returns null when @ is mid-word (email-like)", () => {
    expect(detectMentionTrigger("a@b", 3)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the trigger with an encoded mention token", () => {
    const text = "hi @jo";
    const trig = detectMentionTrigger(text, text.length)!;
    const out = applyMention(text, text.length, trig, "usr_jones");
    expect(out.text).toBe("hi <@usr_jones> ");
    expect(out.caret).toBe(out.text.length);
  });
});
