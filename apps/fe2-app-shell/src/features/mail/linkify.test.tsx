import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { linkifySegments } from "./linkify.ts";
import { LinkifiedText, SanitizedHtml } from "./MailBody.tsx";

const links = (text: string): string[] => linkifySegments(text).flatMap((s) => (s.kind === "link" ? [s.href] : []));
const roundTrip = (text: string): string => linkifySegments(text).map((s) => s.text).join("");

describe("linkifySegments (mail body URL boundaries)", () => {
  it("leaves text without URLs as one text segment", () => {
    expect(linkifySegments("こんにちは\n世界")).toEqual([{ kind: "text", text: "こんにちは\n世界" }]);
  });

  it("stops at full-width brackets and punctuation glued to the URL", () => {
    expect(links("参加登録はこちら（https://ex.jp/e/1/?a=1&b=2）。")).toEqual(["https://ex.jp/e/1/?a=1&b=2"]);
    expect(links("資料「https://drive.ex.com/file/d/1Ab/view?usp=sharing」をご確認ください")).toEqual([
      "https://drive.ex.com/file/d/1Ab/view?usp=sharing",
    ]);
    expect(links("詳細はhttps://ex.jp/pathをご覧ください、よろしく")).toEqual(["https://ex.jp/path"]);
    expect(links("https://a.jp、https://b.jp。")).toEqual(["https://a.jp", "https://b.jp"]);
  });

  it("keeps query strings, fragments and percent-encoding intact", () => {
    const url = "https://maps.ex.com/place/%E9%87%91%E6%B2%A2/@36.53,136.62,17z/data=!3m1!4b1?q=a+b&x=%20#map-section";
    expect(links(`会場マップ: ${url}`)).toEqual([url]);
  });

  it("drops trailing ASCII sentence punctuation but keeps balanced parens", () => {
    expect(links("See https://github.com/org/repo/pull/752.")).toEqual(["https://github.com/org/repo/pull/752"]);
    expect(links("ok? https://ex.jp/a, then")).toEqual(["https://ex.jp/a"]);
    expect(links("(https://ex.jp/x)")).toEqual(["https://ex.jp/x"]);
    expect(links("https://ja.wikipedia.org/wiki/Cloudflare_(企業)、次")).toEqual(["https://ja.wikipedia.org/wiki/Cloudflare_(企業)"]);
    expect(links("[https://ex.jp/a]")).toEqual(["https://ex.jp/a"]);
  });

  it("links Gmail-style `label<url>` without showing the angle brackets", () => {
    const segs = linkifySegments("タイムテーブルの詳細<https://conf.ex.jp/t?day=1&track=A#s-42>です");
    expect(segs).toEqual([
      { kind: "text", text: "タイムテーブルの詳細 " },
      { kind: "link", text: "https://conf.ex.jp/t?day=1&track=A#s-42", href: "https://conf.ex.jp/t?day=1&track=A#s-42" },
      { kind: "text", text: "です" },
    ]);
  });

  it("rejoins an angle-bracketed URL hard-wrapped across lines", () => {
    expect(links("アンケート <https://forms.ex.com/d/e/1FAI/viewform?usp=pp_url&entry.1=\nabc> へ")).toEqual([
      "https://forms.ex.com/d/e/1FAI/viewform?usp=pp_url&entry.1=abc",
    ]);
  });

  it("never links non-http schemes or a scheme without a host", () => {
    expect(links("javascript:alert(1) data:text/html,x <javascript:alert(1)> https:// http://")).toEqual([]);
  });

  it("preserves all non-URL text exactly (no characters lost)", () => {
    const t = "A（https://ex.jp/a）。B「https://ex.jp/b」C https://ex.jp/c. D";
    expect(roundTrip(t)).toBe(t);
  });
});

describe("LinkifiedText / SanitizedHtml rendering", () => {
  it("renders safe anchors that open in a new tab and wrap long URLs", () => {
    const long = `https://ex.jp/${"a".repeat(300)}`;
    render(<LinkifiedText testId="body" text={`前（${long}）後`} />);
    const a = screen.getByRole("link");
    expect(a.getAttribute("href")).toBe(long);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByTestId("body").textContent).toBe(`前（${long}）後`);
  });

  it("strips inline styles from HTML anchors and forces rel/target", () => {
    render(<SanitizedHtml testId="html" html={'<a href="https://ex.jp/x" style="white-space:nowrap" onclick="x()">x</a>'} />);
    const a = screen.getByRole("link");
    expect(a.getAttribute("style")).toBeNull();
    expect(a.getAttribute("onclick")).toBeNull();
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.getAttribute("target")).toBe("_blank");
  });
});
