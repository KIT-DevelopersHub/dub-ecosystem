import { describe, expect, it } from "vitest";
import { applyInputRules, ensureLines, placeCaret, renderEditor, serializeEditor, splitLine } from "./composer-editor";

function editorFrom(html: string): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.replaceChildren(root);
  return root;
}

const roundTrip = (md: string): string => {
  const root = editorFrom("");
  renderEditor(root, md, { user: (id) => (id === "usr_rin" ? "Rin" : undefined) });
  return serializeEditor(root);
};

describe("serializeEditor", () => {
  it("emits the Markdown subset for each inline style", () => {
    const root = editorFrom(
      "<div><b>b</b> <i>i</i> <u>u</u> <s>s</s> <code>c</code> <a href=\"https://x.dev\">x</a></div>",
    );
    expect(serializeEditor(root)).toBe("*b* _i_ ++u++ ~s~ `c` [x](https://x.dev)");
  });

  it("keeps edge spaces outside the markers and merges adjacent equal runs", () => {
    const root = editorFrom("<div>a<b> bo</b><strong>ld </strong>c</div>");
    expect(serializeEditor(root)).toBe("a *bold* c");
  });

  it("turns line blocks into prefixes, numbering consecutive ordered lines", () => {
    const root = editorFrom(
      '<div data-block="quote">q</div><div data-block="bullet">a</div><div data-block="ordered">x</div><div data-block="ordered">y</div><div data-block="code">let a = *1*</div>',
    );
    expect(serializeEditor(root)).toBe("> q\n- a\n1. x\n2. y\n```\nlet a = *1*\n```");
  });

  it("reads browser-made shapes: bare text, <br> line breaks, empty-line divs", () => {
    expect(serializeEditor(editorFrom("a<br>b"))).toBe("a\nb");
    expect(serializeEditor(editorFrom("<div>a</div><div><br></div><div>b<br></div>"))).toBe("a\n\nb");
  });

  it("drops trailing empty lines and zero-width caret pads", () => {
    expect(serializeEditor(editorFrom('<div>a​</div><div data-block="bullet"><br></div>'))).toBe("a");
  });

  it("writes mention chips back as their wire token", () => {
    const root = editorFrom('<div>hi <span data-md="<@usr_rin>">@Rin</span> </div>');
    expect(serializeEditor(root)).toBe("hi <@usr_rin> ");
  });
});

describe("renderEditor", () => {
  it("round-trips what the renderer understands", () => {
    for (const md of [
      "plain",
      "*b* _i_ ++u++ ~s~ `c`",
      "a\n\nb",
      "> q1\n> q2",
      "- a\n- b",
      "1. a\n2. b",
      "```\ncode *raw*\n```",
      "see [docs](https://x.dev) and https://y.dev",
      "hi <@usr_rin> and <!team:team_hq>",
    ]) {
      expect(roundTrip(md)).toBe(md);
    }
  });

  it("shows mentions as named chips, never the raw token", () => {
    const root = editorFrom("");
    renderEditor(root, "hi <@usr_rin>", { user: () => "Rin" });
    expect(root.textContent).toBe("hi @Rin");
  });
});

describe("editing", () => {
  it("applyInputRules converts *x* before the caret to bold", () => {
    const root = editorFrom("<div>a *x*</div>");
    const text = root.firstChild!.firstChild!;
    placeCaret(text, 5);
    expect(applyInputRules(root)).toBe(true);
    expect(root.querySelector("b")?.textContent).toBe("x");
    expect(serializeEditor(root)).toBe("a *x*");
  });

  it("applyInputRules leaves underscores inside a URL alone", () => {
    const root = editorFrom("<div>https://x.dev/a_b_</div>");
    placeCaret(root.firstChild!.firstChild!, 18);
    expect(applyInputRules(root)).toBe(false);
  });

  it("applyInputRules turns a leading '- ' into a bullet line", () => {
    const root = editorFrom("<div>- </div>");
    placeCaret(root.firstChild!.firstChild!, 2);
    expect(applyInputRules(root)).toBe(true);
    expect((root.firstChild as HTMLElement).dataset.block).toBe("bullet");
  });

  it("splitLine continues a list, and an empty list line exits it", () => {
    const root = editorFrom('<div data-block="bullet">a</div>');
    placeCaret(root.firstChild!.firstChild!, 1);
    splitLine(root);
    expect(root.children).toHaveLength(2);
    expect((root.children[1] as HTMLElement).dataset.block).toBe("bullet");
    splitLine(root);
    expect(root.children).toHaveLength(2);
    expect((root.children[1] as HTMLElement).dataset.block).toBeUndefined();
  });

  it("ensureLines wraps stray root text into a line", () => {
    const root = editorFrom("a<div>b</div>");
    ensureLines(root);
    expect(root.innerHTML).toBe("<div>a</div><div>b</div>");
  });
});
