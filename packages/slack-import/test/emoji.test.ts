import { describe, expect, it } from "vitest";
import { customEmojiContentType, customEmojiR2Key, isSlackEmojiUrl, isValidCustomEmojiName, parseSlackEmojiList } from "../src/emoji";

describe("parseSlackEmojiList", () => {
  it("splits images and aliases (sorted by name) and rejects unsafe entries", () => {
    const parsed = parseSlackEmojiList({
      "kit-dev": "https://emoji.slack-edge.com/T0/kit-dev/1.png",
      partyparrot: "https://emoji.slack-edge.com/T0/partyparrot/2.gif",
      parrot: "alias:partyparrot",
      thumbsup_all: "alias:thumbsup",
      "bad/name": "https://emoji.slack-edge.com/T0/x/3.png",
      offsite: "https://evil.example/x.png",
      broken_alias: "alias:a/b",
    });
    expect(parsed.images.map((i) => i.name)).toEqual(["kit-dev", "partyparrot"]);
    expect(parsed.aliases).toEqual([
      { name: "parrot", target: "partyparrot" },
      { name: "thumbsup_all", target: "thumbsup" },
    ]);
    expect(parsed.invalid).toEqual(["bad/name", "broken_alias", "offsite"]);
  });
});

describe("name / url / type guards", () => {
  it("accepts Slack-style names (incl. non-ASCII) and rejects path / colon / blank", () => {
    for (const ok of ["ok", "kit-dev", "a_b+1", "やったー"]) expect(isValidCustomEmojiName(ok), ok).toBe(true);
    for (const bad of ["", ".", "..", "a:b", "a/b", "a b", "a%2F", "x".repeat(101), "a?b"]) expect(isValidCustomEmojiName(bad), bad).toBe(false);
  });

  it("only trusts https *.slack-edge.com", () => {
    expect(isSlackEmojiUrl("https://emoji.slack-edge.com/T0/a/1.png")).toBe(true);
    expect(isSlackEmojiUrl("http://emoji.slack-edge.com/T0/a/1.png")).toBe(false);
    expect(isSlackEmojiUrl("https://slack-edge.com.evil.example/a.png")).toBe(false);
    expect(isSlackEmojiUrl("https://user:pw@emoji.slack-edge.com/a.png")).toBe(false);
    expect(isSlackEmojiUrl("not a url")).toBe(false);
  });

  it("keeps the original raster type (header first, then extension) and refuses SVG", () => {
    expect(customEmojiContentType("image/gif", "https://e/x.png")).toBe("image/gif");
    expect(customEmojiContentType("application/octet-stream", "https://e/x.JPG")).toBe("image/jpeg");
    expect(customEmojiContentType(null, "https://e/x.webp")).toBe("image/webp");
    expect(customEmojiContentType("image/svg+xml", "https://e/x.svg")).toBeNull();
    expect(customEmojiContentType("text/html", "https://e/x")).toBeNull();
  });

  it("stores under the custom-emoji/ prefix", () => {
    expect(customEmojiR2Key("partyparrot")).toBe("custom-emoji/partyparrot");
  });
});
