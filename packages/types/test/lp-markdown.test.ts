import { describe, it, expect } from "vitest";
import { lpMarkdown } from "../src/index";

const { renderLpMarkdown: md, toEmbeddableImageUrl, googleDriveFileId } = lpMarkdown;
const ID = "1pi6s-HA6FR0YyWVVPbXonxmqTOn2QInr";

describe("toEmbeddableImageUrl (Google ドライブ)", () => {
  it("turns Drive share links into the lh3 image URL", () => {
    for (const u of [
      `https://drive.google.com/file/d/${ID}/view?usp=sharing`,
      `https://drive.google.com/file/d/${ID}/view?usp=drive_link`,
      `https://drive.google.com/file/d/${ID}/edit`,
      `https://drive.google.com/file/d/${ID}`,
      `https://drive.google.com/file/u/0/d/${ID}/view`,
      `https://drive.google.com/open?id=${ID}`,
      `https://drive.google.com/uc?export=view&id=${ID}`,
      `https://drive.google.com/thumbnail?id=${ID}&sz=w400`,
      `https://docs.google.com/uc?id=${ID}`,
    ]) {
      expect(googleDriveFileId(u)).toBe(ID);
      expect(toEmbeddableImageUrl(u)).toBe(`https://lh3.googleusercontent.com/d/${ID}=w1600`);
    }
    expect(toEmbeddableImageUrl(`https://drive.google.com/open?id=${ID}`, 400)).toBe(`https://lh3.googleusercontent.com/d/${ID}=w400`);
  });

  it("leaves other URLs as they are", () => {
    for (const u of [
      "https://example.com/logo.png",
      "/sponsors/a.png",
      "https://drive.google.com/drive/folders/abcdefghijklmn",
      "https://evil.example/file/d/abcdefghijklmn/view",
      "https://drive.google.com.evil.example/file/d/abcdefghijklmn/view",
      "https://drive.google.com/file/d/<script>/view",
    ]) {
      expect(toEmbeddableImageUrl(u)).toBe(u);
    }
  });
});

describe("renderLpMarkdown", () => {
  it("renders the note-like basics", () => {
    expect(md("# 大見出し\n### 小見出し")).toBe("<h3>大見出し</h3><h4>小見出し</h4>");
    expect(md("1行目\n2行目\n\n次の段落")).toBe("<p>1行目<br>2行目</p><p>次の段落</p>");
    expect(md("**太字** と *斜体* と ~~消し~~ と `code`")).toBe(
      "<p><strong>太字</strong> と <em>斜体</em> と <del>消し</del> と <code>code</code></p>",
    );
    expect(md("- a\n- b\n  - b1\n- c")).toBe("<ul><li>a</li><li>b<ul><li>b1</li></ul></li><li>c</li></ul>");
    expect(md("3. 三\n4. 四")).toBe('<ol start="3"><li>三</li><li>四</li></ol>');
    expect(md("> 引用\n> **強調**")).toBe("<blockquote><p>引用<br><strong>強調</strong></p></blockquote>");
    expect(md("---")).toBe("<hr>");
    expect(md("```\n<b>x</b>\n```")).toBe("<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>");
    expect(md("snake_case_name")).toBe("<p>snake_case_name</p>");
  });

  it("links open in a new tab; bare URLs are linked", () => {
    expect(md("[公式](https://example.com/a?b=1&c=2)")).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">公式</a></p>',
    );
    expect(md("詳細は https://example.com/x 。")).toBe(
      '<p>詳細は <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a> 。</p>',
    );
  });

  it("images: http(s) only, Drive links normalized, an image-only paragraph becomes a figure", () => {
    expect(md(`![会場の様子](https://drive.google.com/file/d/${ID}/view?usp=sharing)`)).toBe(
      `<figure><img src="https://lh3.googleusercontent.com/d/${ID}=w1600" alt="会場の様子" loading="lazy" decoding="async" referrerpolicy="no-referrer"><figcaption>会場の様子</figcaption></figure>`,
    );
    expect(md("前 ![a](https://e.com/a.png) 後")).toContain('<img src="https://e.com/a.png" alt="a"');
    expect(md("![x](data:image/png;base64,AAAA)")).toBe("<p>x</p>");
  });

  it("never outputs raw HTML, scripts or javascript: links", () => {
    const out = md(
      '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[click](javascript:alert(1))\n[c2](JaVaScRiPt:alert(1))\n![i](javascript:alert(1))\n[q](https://e.com/"onmouseover="x)',
    );
    expect(out).not.toMatch(/<script|<img src=x|javascript:|href="(?!https?:)/i);
    expect(out).not.toMatch(/"onmouseover=/);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("click");
    // 決まったタグ以外は出ない
    const tags = new Set([...md("# a\n**b** [c](https://e.com) ![d](https://e.com/d.png)\n- e\n> f\n---\n```\ng\n```").matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]));
    for (const t of tags) expect(["h3", "h4", "p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "hr", "a", "img", "figure", "figcaption"]).toContain(t);
  });

  it("is safe on pathological input", () => {
    expect(() => md("*".repeat(5000) + "[".repeat(3000) + "> ".repeat(2000))).not.toThrow();
    expect(md("")).toBe("");
  });
});
