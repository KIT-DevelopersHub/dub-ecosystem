// Regression: (1) a long multi-line sent reply folded into a conversation rendered as the
// list snippet (one line, cut at 140 chars) — jumbled and never readable to the end; the
// thread fill now fetches each folded reply's full Sent detail. (2) The inline reply box
// can carry Cc/Bcc (Cc/Bcc toggle reveals the shared EmailAddressSelect fields).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { DEMO_INBOX_ITEMS, DEMO_INBOX_THREAD, DEMO_SENT_DETAIL, DEMO_SENT_ITEMS } from "./mailModel.fixtures.ts";

function fakeApi(over: Partial<MailApi> = {}): MailApi {
  return {
    send: vi.fn().mockResolvedValue({ messageId: "m", provider: "resend", acceptedAt: "t" }),
    listInbox: vi.fn().mockResolvedValue({ items: DEMO_INBOX_ITEMS, nextCursor: null }),
    getMessage: vi.fn(),
    getThread: vi.fn().mockResolvedValue(DEMO_INBOX_THREAD),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    listSent: vi.fn().mockResolvedValue({ items: DEMO_SENT_ITEMS, nextCursor: null }),
    getSent: vi.fn().mockResolvedValue(DEMO_SENT_DETAIL),
    downloadAttachment: vi.fn().mockResolvedValue(new Blob(["x"])),
    listFlags: vi.fn().mockResolvedValue([]),
    setFlags: vi.fn().mockImplementation((threadId: string, patch: Record<string, boolean>) =>
      Promise.resolve({ threadId, starred: false, archived: false, trashed: false, purged: false, ...patch }),
    ),
    schedule: vi.fn(),
    listScheduled: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getScheduled: vi.fn(),
    updateScheduled: vi.fn(),
    cancelScheduled: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue([]),
    addBlock: vi.fn().mockImplementation((req: { value: string; kind?: "address" | "domain" }) => Promise.resolve({ value: req.value.toLowerCase(), kind: req.kind ?? "address", createdAt: "2026-01-01T00:00:00.000Z" })),
    removeBlock: vi.fn().mockImplementation((value: string) => Promise.resolve({ value, blocked: false })),
    counts: vi.fn().mockRejectedValue(new Error("no counts")),
    ...over,
  };
}

const LONG_BODY = [
  "山田様",
  "",
  "ご連絡ありがとうございます。",
  "以下の通り対応いたします。",
  ...Array.from({ length: 12 }, (_, i) => `${i + 1}. 確認事項その${i + 1}について詳細をお送りします。`),
  "",
  "最後の行です（末尾まで表示されること）",
].join("\n");

describe("long sent reply in a conversation", () => {
  it("renders the full multi-line body, not the one-line 140-char snippet", async () => {
    const snippet = LONG_BODY.replace(/\s+/g, " ").trim().slice(0, 140);
    const item: mail.MailSentListItem = {
      id: "sent_long",
      from: { email: "info@developershub.jp" },
      to: [{ email: "hanako@example.com", name: "山田 花子" }],
      subject: "Re: 登壇のご相談",
      snippet,
      sentAt: "2099-08-10T02:00:00.000Z", // newest → expanded
      provider: "resend",
      status: "sent",
      threadId: "thr_in_1",
    };
    const detail: mail.MailSentDetail = { ...item, textBody: LONG_BODY } as mail.MailSentDetail;
    const getSent = vi.fn().mockResolvedValue(detail);
    const api = fakeApi({
      listInbox: vi.fn().mockResolvedValue({ items: [DEMO_INBOX_ITEMS[0]!], nextCursor: null }),
      listSent: vi.fn().mockResolvedValue({ items: [item], nextCursor: null }),
      getSent,
    });
    render(<MailApiProvider value={api}><GmailApp /></MailApiProvider>);
    await userEvent.click((await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!);
    await waitFor(() => expect(getSent).toHaveBeenCalledWith("sent_long"));
    await waitFor(() => {
      const bodies = screen.getAllByTestId("fe2-mail-body-text").map((el) => el.textContent ?? "");
      expect(bodies).toContain(LONG_BODY); // newlines intact, last line present
    });
    expect(screen.getAllByTestId("fe2-mail-body-text").at(-1)!).toHaveStyle({ whiteSpace: "pre-wrap" });
  });
});

describe("inline reply Cc/Bcc", () => {
  it("hides Cc/Bcc until toggled, then sends cc/bcc with In-Reply-To", async () => {
    const api = fakeApi();
    render(<MailApiProvider value={api}><GmailApp /></MailApiProvider>);
    await userEvent.click((await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!);
    await waitFor(() => expect(screen.getByText(/相談させてください/)).toBeInTheDocument());
    expect(screen.queryByTestId("fe2-mail-inline-cc")).toBeNull();
    await userEvent.click(screen.getByTestId("fe2-mail-inline-ccbcc-toggle"));
    await userEvent.type(screen.getByTestId("fe2-mail-inline-cc"), "cc@example.com,");
    await userEvent.type(screen.getByTestId("fe2-mail-inline-bcc"), "secret@example.com,");
    await userEvent.type(screen.getByTestId("fe2-mail-inline-reply"), "1行目{enter}2行目");
    await userEvent.click(screen.getByTestId("fe2-mail-inline-send"));
    expect(api.send).toHaveBeenCalledTimes(1);
    const sent = (api.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as mail.SendMailRequest;
    expect(sent.to).toEqual([{ email: "hanako@example.com", name: "山田 花子" }]);
    expect(sent.cc).toEqual([{ email: "cc@example.com" }]);
    expect(sent.bcc).toEqual([{ email: "secret@example.com" }]);
    expect(sent.inReplyTo).toBe("<in1@developershub.jp>");
    expect(sent.textBody).toBe("1行目\n2行目");
    // Fields reset after send.
    expect(screen.queryByTestId("fe2-mail-inline-cc")).toBeNull();
  });

  it("omits cc/bcc when not set", async () => {
    const api = fakeApi();
    render(<MailApiProvider value={api}><GmailApp /></MailApiProvider>);
    await userEvent.click((await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!);
    await waitFor(() => expect(screen.getByText(/相談させてください/)).toBeInTheDocument());
    await userEvent.type(screen.getByTestId("fe2-mail-inline-reply"), "了解です");
    await userEvent.click(screen.getByTestId("fe2-mail-inline-send"));
    const sent = (api.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as mail.SendMailRequest;
    expect(sent.cc).toBeUndefined();
    expect(sent.bcc).toBeUndefined();
  });

  it("the inline reply textarea grows with content instead of a fixed box", async () => {
    render(<MailApiProvider value={fakeApi()}><GmailApp /></MailApiProvider>);
    await userEvent.click((await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!);
    const ta = await screen.findByTestId("fe2-mail-inline-reply");
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => 420 });
    await userEvent.type(ta, "a{enter}b{enter}c");
    expect(ta.style.height).toBe("420px");
    expect(ta).toHaveStyle({ overflowY: "auto", whiteSpace: "pre-wrap" });
  });
});
