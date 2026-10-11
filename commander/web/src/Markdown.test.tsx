import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "./Markdown.tsx";

const md = (text: string) => render(<Markdown text={text} />).container;

describe("Markdown", () => {
  it("renders headings, emphasis, inline code and line breaks", () => {
    const c = md("## 結論\n\n**追加しました**。`pnpm test` が通過。\n次の行");
    expect(c.querySelector("h2")?.textContent).toBe("結論");
    expect(c.querySelector("strong")?.textContent).toBe("追加しました");
    expect(c.querySelector("code")?.textContent).toBe("pnpm test");
    expect(c.querySelector("p br")).not.toBeNull();
  });

  it("renders GFM tables with header and body cells", () => {
    const c = md("| # | 手順 |\n|---|---|\n| 1 | **開く** |\n| 2 | 押す |");
    expect([...c.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["#", "手順"]);
    expect(c.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(c.querySelector("td strong")?.textContent).toBe("開く");
  });

  it("renders nested lists and keeps continuation lines in the item", () => {
    const c = md("- 親\n  - 子1\n  - 子2\n- 次\n  続き\n\n1. one\n2. two");
    const top = c.querySelector("ul")!;
    expect(top.children).toHaveLength(2);
    expect(top.querySelectorAll(":scope ul li")).toHaveLength(2);
    expect(top.children[1]!.textContent).toBe("次続き");
    expect(top.children[1]!.querySelector("br")).not.toBeNull();
    expect(c.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("renders fenced code verbatim (no inline formatting inside)", () => {
    const c = md("```bash\npnpm **test**\n```");
    expect(c.querySelector("pre code")?.textContent).toBe("pnpm **test**");
    expect(c.querySelector("strong")).toBeNull();
  });

  it("links only safe protocols and never injects HTML", () => {
    const c = md("[demo](https://example.com) [x](javascript:alert(1)) <img src=x onerror=alert(1)>");
    const links = [...c.querySelectorAll("a")];
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("https://example.com");
    expect(links[0]!.getAttribute("rel")).toContain("noopener");
    expect(c.querySelector("img")).toBeNull();
  });

  it("autolinks bare URLs and renders blockquotes and rules", () => {
    const c = md("> 注意\n\n---\n\nhttps://dub.example/x を開く");
    expect(c.querySelector("blockquote")?.textContent).toBe("注意");
    expect(c.querySelector("hr")).not.toBeNull();
    expect(c.querySelector("a")?.getAttribute("href")).toBe("https://dub.example/x");
  });
});
