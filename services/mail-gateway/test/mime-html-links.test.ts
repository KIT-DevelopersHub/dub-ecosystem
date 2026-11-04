import { describe, it, expect } from "vitest";
import { extractBody, htmlToText } from "../src/mime";

describe("htmlToText keeps link targets (HTML-only mail)", () => {
  it("renders a labelled anchor as `label <url>` and decodes &amp; in the href", () => {
    expect(htmlToText('<p>詳細は<a href="https://ex.jp/a?x=1&amp;y=2#s" style="color:red">こちら</a>です</p>')).toBe(
      "詳細はこちら <https://ex.jp/a?x=1&y=2#s>です\n",
    );
  });

  it("collapses an anchor whose label is the URL itself", () => {
    expect(htmlToText("<a href='https://ex.jp/'>https://ex.jp</a>")).toBe("https://ex.jp/");
  });

  it("keeps only the label for non-http(s) hrefs", () => {
    expect(htmlToText('<a href="javascript:alert(1)">押す</a> <a href="mailto:a@b.jp">連絡</a>')).toBe("押す 連絡");
  });

  it("does not let a literal &lt;tag&gt; in text be mistaken for markup", () => {
    expect(htmlToText("<b>a</b> &lt;b&gt; <a href=https://ex.jp/x>x</a>")).toBe("a <b> x <https://ex.jp/x>");
  });

  it("extractBody keeps the href of an HTML-only message", () => {
    const raw = [
      "From: a@ex.jp",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<div>登録は<a href="https://connpass.example/event/1/?utm_source=mail&amp;utm_medium=email">こちら</a></div>',
    ].join("\r\n");
    expect(extractBody(raw)).toBe("登録はこちら <https://connpass.example/event/1/?utm_source=mail&utm_medium=email>");
  });
});
