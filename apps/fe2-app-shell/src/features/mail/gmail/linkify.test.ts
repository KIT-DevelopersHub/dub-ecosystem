import { describe, expect, it } from "vitest";
import { linkifyBody } from "./linkify.ts";

const links = (s: string): string[] => linkifyBody(s).flatMap((p) => (p.type === "link" ? [p.href] : []));

describe("linkifyBody", () => {
  it("round-trips the text and links bare URLs", () => {
    const body = "会場はこちら\nhttps://ex.com/a?x=1&y=2\n以上";
    const parts = linkifyBody(body);
    expect(parts.map((p) => (p.type === "link" ? p.href : p.value)).join("")).toBe(body);
    expect(links(body)).toEqual(["https://ex.com/a?x=1&y=2"]);
  });

  it("stops at Japanese brackets / punctuation and angle brackets", () => {
    expect(links("特設ページ（https://ex.com/lp）をご覧ください。")).toEqual(["https://ex.com/lp"]);
    expect(links("配信停止はこちら<https://ex.com/u?t=1>")).toEqual(["https://ex.com/u?t=1"]);
    expect(links("見てください https://ex.com/a、https://ex.com/b。")).toEqual(["https://ex.com/a", "https://ex.com/b"]);
  });

  it("trims trailing sentence punctuation but keeps balanced parens", () => {
    expect(links("see https://ex.com/x.")).toEqual(["https://ex.com/x"]);
    expect(links("(see https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  });

  it("does not link a bare scheme or non-http text", () => {
    expect(links("https:// だけ / ftp://ex.com / javascript:alert(1)")).toEqual([]);
  });
});
