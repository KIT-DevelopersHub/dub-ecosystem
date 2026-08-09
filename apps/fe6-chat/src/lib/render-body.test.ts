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
});
