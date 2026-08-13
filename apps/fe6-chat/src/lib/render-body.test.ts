import { describe, it, expect } from "vitest";
import { segmentBody } from "./render-body";

describe("segmentBody", () => {
  it("splits text and mentions", () => {
    expect(segmentBody("hi <@usr_a> there")).toEqual([
      { type: "text", value: "hi " },
      { type: "mention", userId: "usr_a" },
      { type: "text", value: " there" },
    ]);
  });

  it("treats <@x> inside backticks as literal code", () => {
    expect(segmentBody("`<@usr_a>`")).toEqual([{ type: "code", value: "<@usr_a>" }]);
  });

  it("returns a single text segment when there are no tokens", () => {
    expect(segmentBody("plain")).toEqual([{ type: "text", value: "plain" }]);
  });

  it("parses bold / italic / strike inline styles", () => {
    expect(segmentBody("a *b* _i_ ~s~")).toEqual([
      { type: "text", value: "a " },
      { type: "bold", value: "b" },
      { type: "text", value: " " },
      { type: "italic", value: "i" },
      { type: "text", value: " " },
      { type: "strike", value: "s" },
    ]);
  });

  it("parses links [label](url)", () => {
    expect(segmentBody("see [docs](https://example.com/x)")).toEqual([
      { type: "text", value: "see " },
      { type: "link", label: "docs", href: "https://example.com/x" },
    ]);
  });

  it("does not treat markers inside code as inline styles", () => {
    expect(segmentBody("`a*b*c`")).toEqual([{ type: "code", value: "a*b*c" }]);
  });
});
