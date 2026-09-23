import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageComposer } from "./MessageComposer";
import type { MentionCandidate } from "../lib/mentions";
import { loadDraft } from "../store/draft";

const candidates: MentionCandidate[] = [
  { kind: "user", id: "usr_rin", label: "Rin", avatarUrl: null },
  { kind: "user", id: "usr_ren", label: "Ren", avatarUrl: null },
  { kind: "team", id: "team_hq", label: "統括チーム", color: "#1e3a5f" },
  { kind: "team", id: "team_corp", label: "法人チーム", color: "#7c3aed" },
];
const resolveCandidates = (q: string): MentionCandidate[] =>
  candidates.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));

describe("MessageComposer", () => {
  beforeEach(() => {
    globalThis.sessionStorage?.clear();
  });

  it("disables send for an empty/whitespace body and enables once typed", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    const send = screen.getByTestId("fe6-composer-send");
    expect(send).toBeDisabled();
    await user.type(screen.getByTestId("fe6-composer-input"), "hello");
    expect(send).toBeEnabled();
  });

  it("sends the body and clears the input + draft", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageComposer channelId="chn_a" onSend={onSend} />);
    const input = screen.getByTestId("fe6-composer-input");
    await user.type(input, "ship it");
    await user.click(screen.getByTestId("fe6-composer-send"));
    expect(onSend).toHaveBeenCalledWith("ship it", undefined);
    expect(loadDraft("chn_a")).toBe("");
  });

  it("persists a draft to sessionStorage as the user types", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    await user.type(screen.getByTestId("fe6-composer-input"), "wip");
    expect(loadDraft("chn_a")).toBe("wip");
  });

  it("shows a mention menu and inserts <@userId> on selection", async () => {
    const user = userEvent.setup();
    render(
      <MessageComposer
        channelId="chn_a"
        onSend={vi.fn()}
        resolveMentionCandidates={resolveCandidates}
      />,
    );
    const input = screen.getByTestId("fe6-composer-input") as HTMLTextAreaElement;
    await user.type(input, "hi @ri");
    expect(screen.getByTestId("fe6-composer-mention-menu")).toBeInTheDocument();
    await user.click(screen.getByText("Rin"));
    expect(input.value).toBe("hi <@usr_rin> ");
  });

  it("offers 運営チーム in the same menu and inserts <!team:teamId> on selection", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} resolveMentionCandidates={resolveCandidates} />);
    const input = screen.getByTestId("fe6-composer-input") as HTMLTextAreaElement;
    await user.type(input, "@法人");
    expect(screen.getByTestId("fe6-composer-mention-menu")).toBeInTheDocument();
    await user.click(screen.getByText("法人チーム"));
    expect(input.value).toBe("<!team:team_corp> ");
  });

  it("disables the input when archived", () => {
    render(<MessageComposer channelId="chn_a" disabled disabledReason="archived" onSend={vi.fn()} />);
    expect(screen.getByTestId("fe6-composer-input")).toBeDisabled();
    expect(screen.getByTestId("fe6-composer-send")).toBeDisabled();
  });

  it("shows an inline error when provided", () => {
    render(<MessageComposer channelId="chn_a" error="本文を確認してください" onSend={vi.fn()} />);
    expect(screen.getByTestId("fe6-composer-error")).toHaveTextContent("本文を確認してください");
  });

  it("underline button wraps the selection with ++", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    const input = screen.getByTestId("fe6-composer-input") as HTMLTextAreaElement;
    await user.type(input, "word");
    input.setSelectionRange(0, 4);
    await user.click(screen.getByLabelText("下線"));
    expect(input.value).toBe("++word++");
  });

  it("quote button prefixes the line with '> '", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    const input = screen.getByTestId("fe6-composer-input") as HTMLTextAreaElement;
    await user.type(input, "hello");
    input.setSelectionRange(0, 5);
    await user.click(screen.getByLabelText("引用"));
    expect(input.value).toBe("> hello");
  });

  it("ordered-list button numbers each selected line", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    const input = screen.getByTestId("fe6-composer-input") as HTMLTextAreaElement;
    await user.type(input, "a{Shift>}{Enter}{/Shift}b");
    input.setSelectionRange(0, input.value.length);
    await user.click(screen.getByLabelText("番号付きリスト"));
    expect(input.value).toBe("1. a\n2. b");
  });

  it("does NOT send on the IME 変換確定 Enter, but sends on the following plain Enter", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<MessageComposer channelId="chn_a" onSend={onSend} />);
    const input = screen.getByTestId("fe6-composer-input") as HTMLTextAreaElement;
    await user.type(input, "こんにちは");

    // 変換確定 Enter: fires mid-composition (isComposing=true / keyCode 229) — must not send.
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("こんにちは");

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
    const input = screen.getByTestId("fe6-composer-input") as HTMLTextAreaElement;
    await user.type(input, "hi @ri");
    expect(screen.getByTestId("fe6-composer-mention-menu")).toBeInTheDocument();
    // Composing (e.g. converting the query) — Enter belongs to the IME, not the menu.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(input.value).toBe("hi @ri");
  });

  it("Cmd+B wraps the selection in *bold*", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    const input = screen.getByTestId("fe6-composer-input") as HTMLTextAreaElement;
    await user.type(input, "x");
    input.setSelectionRange(0, 1);
    await user.keyboard("{Meta>}b{/Meta}");
    expect(input.value).toBe("*x*");
  });

  it("P13: pulses the send button (data-sent) briefly after sending, then clears it", async () => {
    const user = userEvent.setup();
    render(<MessageComposer channelId="chn_a" onSend={vi.fn()} />);
    const input = screen.getByTestId("fe6-composer-input") as HTMLTextAreaElement;
    const send = screen.getByTestId("fe6-composer-send");
    await user.type(input, "hi");
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
