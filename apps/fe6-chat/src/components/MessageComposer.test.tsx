import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageComposer } from "./MessageComposer";
import type { MentionCandidate } from "../lib/mentions";
import { loadDraft } from "../store/draft";
import { caretToEnd } from "../lib/composer-editor";

const candidates: MentionCandidate[] = [
  { kind: "user", id: "usr_rin", label: "Rin", avatarUrl: null },
  { kind: "user", id: "usr_ren", label: "Ren", avatarUrl: null },
  { kind: "team", id: "team_hq", label: "統括チーム", color: "#1e3a5f" },
  { kind: "team", id: "team_corp", label: "法人チーム", color: "#7c3aed" },
];
const resolveCandidates = (q: string): MentionCandidate[] =>
  candidates.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));

// The input is a contentEditable WYSIWYG editor; the Markdown body it produces is
// observed through the draft (saved on every edit) and onSend.
const draft = () => loadDraft("chn_a");
const editor = () => screen.getByTestId("fe6-composer-input");

// user.type() parks the caret on the editor root (jsdom has no layout to resolve a
// click into a line); a real click lands inside the last line, so do that, then type.
async function typeIn(user: ReturnType<typeof userEvent.setup>, text: string) {
  const el = editor();
  el.focus();
  caretToEnd(el);
  await user.keyboard(text);
}

function selectAll(el: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
}

describe("MessageComposer", () => {
  beforeEach(() => {
    globalThis.sessionStorage?.clear();
  });

  it("disables send for an empty/whitespace body and enables once typed", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    const send = screen.getByTestId("fe6-composer-send");
    expect(send).toBeDisabled();
    await typeIn(user, "hello");
    expect(send).toBeEnabled();
  });

  it("sends the body and clears the input + draft", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageComposer channelId="chn_a" onSend={onSend} />);
    await typeIn(user, "ship it");
    await user.click(screen.getByTestId("fe6-composer-send"));
    expect(onSend).toHaveBeenCalledWith("ship it", undefined);
    expect(draft()).toBe("");
    expect(editor().textContent).toBe("");
  });

  it("persists a draft to sessionStorage as the user types", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    await typeIn(user, "wip");
    expect(draft()).toBe("wip");
  });

  it("restores a saved Markdown draft formatted — no raw * / ` / > on screen", () => {
    sessionStorage.setItem("fe6.chat.draft.chn_a", "*太字* と `code`\n> 引用");
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    const el = editor();
    expect(el.querySelector("b")).toHaveTextContent("太字");
    expect(el.querySelector("code")).toHaveTextContent("code");
    expect(el.querySelector('[data-block="quote"]')).toHaveTextContent("引用");
    expect(el.textContent).not.toMatch(/[*`>]/);
  });

  it("converts typed *text* to bold as you type (Slack parity), keeping Markdown in the body", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    await typeIn(user, "a *b*");
    expect(editor().querySelector("b")).toHaveTextContent("b");
    expect(editor().textContent).not.toContain("*");
    expect(draft()).toBe("a *b*");
  });

  it("shows a mention menu and inserts a chip whose body token is <@userId>", async () => {
    const user = userEvent.setup();
    render(
      <MessageComposer
        channelId="chn_a"
        onSend={vi.fn()}
        resolveMentionCandidates={resolveCandidates}
      />,
    );
    await typeIn(user, "hi @ri");
    expect(screen.getByTestId("fe6-composer-mention-menu")).toBeInTheDocument();
    await user.click(screen.getByText("Rin"));
    expect(draft()).toBe("hi <@usr_rin> ");
    expect(editor()).toHaveTextContent("hi @Rin");
    expect(editor().textContent).not.toContain("<@");
  });

  it("offers 運営チーム in the same menu and inserts <!team:teamId> on selection", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} resolveMentionCandidates={resolveCandidates} />);
    await typeIn(user, "@法人");
    expect(screen.getByTestId("fe6-composer-mention-menu")).toBeInTheDocument();
    await user.click(screen.getByText("法人チーム"));
    expect(draft()).toBe("<!team:team_corp> ");
    expect(editor()).toHaveTextContent("@法人チーム");
  });

  it("disables the input when archived", () => {
    render(<MessageComposer channelId="chn_a" disabled disabledReason="archived" onSend={vi.fn()} />);
    expect(editor()).toHaveAttribute("contenteditable", "false");
    expect(editor()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("fe6-composer-send")).toBeDisabled();
  });

  it("shows an inline error when provided", () => {
    render(<MessageComposer channelId="chn_a" error="本文を確認してください" onSend={vi.fn()} />);
    expect(screen.getByTestId("fe6-composer-error")).toHaveTextContent("本文を確認してください");
  });

  it("quote button turns the line into a quote (body '> hello')", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    await typeIn(user, "hello");
    await user.click(screen.getByLabelText("引用"));
    expect(editor().querySelector('[data-block="quote"]')).toHaveTextContent("hello");
    expect(draft()).toBe("> hello");
  });

  it("ordered-list button numbers each selected line", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    await typeIn(user, "a{Shift>}{Enter}{/Shift}b");
    selectAll(editor());
    await user.click(screen.getByLabelText("番号付きリスト"));
    expect(draft()).toBe("1. a\n2. b");
  });

  it("Cmd+B bolds the selection via the editor (body *x*)", async () => {
    const user = userEvent.setup();
    // jsdom has no execCommand: stand in for the browser's bold.
    const exec = vi.fn((cmd: string) => {
      if (cmd !== "bold") return false;
      const r = document.getSelection()!.getRangeAt(0);
      const b = document.createElement("b");
      b.appendChild(r.extractContents());
      r.insertNode(b);
      return true;
    });
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    await typeIn(user, "x");
    selectAll(editor().firstElementChild as HTMLElement);
    await user.keyboard("{Meta>}b{/Meta}");
    expect(exec).toHaveBeenCalledWith("bold");
    expect(draft()).toBe("*x*");
    delete (document as { execCommand?: unknown }).execCommand;
  });

  it("does NOT send on the IME 変換確定 Enter, but sends on the following plain Enter", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageComposer channelId="chn_a" onSend={onSend} />);
    const input = editor();
    await typeIn(user, "こんにちは");

    // 変換確定 Enter: fires mid-composition (isComposing=true / keyCode 229) — must not send.
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(draft()).toBe("こんにちは");

    // 確定後の単独 Enter: sends.
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("こんにちは", undefined);
  });

  it("does NOT pick a mention on the IME 変換確定 Enter while the menu is open", async () => {
    const user = userEvent.setup();
    render(
      <MessageComposer
        channelId="chn_a"
        onSend={vi.fn()}
        resolveMentionCandidates={resolveCandidates}
      />,
    );
    await typeIn(user, "hi @ri");
    expect(screen.getByTestId("fe6-composer-mention-menu")).toBeInTheDocument();
    // Composing (e.g. converting the query) — Enter belongs to the IME, not the menu.
    fireEvent.keyDown(editor(), { key: "Enter", isComposing: true });
    expect(draft()).toBe("hi @ri");
  });

  it("P13: pulses the send button (data-sent) briefly after sending, then clears it", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    const send = screen.getByTestId("fe6-composer-send");
    await typeIn(user, "hi");
    expect(send).not.toHaveAttribute("data-sent");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(send);
    expect(send).toHaveAttribute("data-sent", "true");

    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(send).not.toHaveAttribute("data-sent");
    vi.useRealTimers();
  });
});
