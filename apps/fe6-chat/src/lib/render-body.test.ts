import { describe, it, expect } from "vitest";
import { inlineSegments, parseBlocks } from "./render-body";

describe("inlineSegments", () => {
  it("splits text and mentions", () => {
    expect(inlineSegments("hi <@usr_a> there")).toEqual([
      { type: "text", value: "hi " },
      { type: "mention", userId: "usr_a" },
      { type: "text", value: " there" },
    ]);
  });

  it("treats <@x> inside backticks as literal code", () => {
    expect(inlineSegments("`<@usr_a>`")).toEqual([{ type: "code", value: "<@usr_a>" }]);
  });

  it("parses bold / italic / underline / strike inline styles", () => {
    expect(inlineSegments("a *b* _i_ ++u++ ~s~")).toEqual([
      { type: "text", value: "a " },
      { type: "bold", value: "b" },
      { type: "text", value: " " },
      { type: "italic", value: "i" },
      { type: "text", value: " " },
      { type: "underline", value: "u" },
      { type: "text", value: " " },
      { type: "strike", value: "s" },
    ]);
  });

  it("parses links [label](url) and ignores markers inside code", () => {
    expect(inlineSegments("see [docs](https://example.com/x)")).toEqual([
      { type: "text", value: "see " },
      { type: "link", label: "docs", href: "https://example.com/x" },
    ]);
    expect(inlineSegments("`a*b*c`")).toEqual([{ type: "code", value: "a*b*c" }]);
  });
});

describe("parseBlocks", () => {
  it("wraps plain text in a paragraph with per-line inlines", () => {
    expect(parseBlocks("hello *world*")).toEqual([
      { type: "paragraph", lines: [[{ type: "text", value: "hello " }, { type: "bold", value: "world" }]] },
    ]);
  });

  it("parses a blockquote (> ) with inline content", () => {
    const blocks = parseBlocks("> quoted _line_");
    expect(blocks[0]!.type).toBe("blockquote");
    expect(blocks).toEqual([
      { type: "blockquote", lines: [[{ type: "text", value: "quoted " }, { type: "italic", value: "line" }]] },
    ]);
  });

  it("parses a bullet list (- ) and an ordered list (1.)", () => {
    expect(parseBlocks("- one\n- two")).toEqual([
      { type: "bullet", items: [[{ type: "text", value: "one" }], [{ type: "text", value: "two" }]] },
    ]);
    expect(parseBlocks("1. first\n2. second")).toEqual([
      { type: "ordered", items: [[{ type: "text", value: "first" }], [{ type: "text", value: "second" }]] },
    ]);
  });

  it("parses a fenced code block with a language hint (contents stay literal)", () => {
    expect(parseBlocks("```ts\nconst a = *1*;\n```")).toEqual([
      { type: "codeblock", value: "const a = *1*;", lang: "ts" },
    ]);
  });

  it("separates a paragraph from a following list", () => {
    const blocks = parseBlocks("intro\n- a\n- b");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "bullet"]);
  });
});
