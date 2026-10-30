// Folder pages come pre-filtered from the gateway (?folder=, blocked senders + flags applied
// before LIMIT): the client must render every conversation it gets (no client-side gap),
// show "1–50 / N", refill a page a local block left short, and badge from GET /mail/counts.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { InboxQuery, MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";

const SPAM = ["promo@shop-a.example", "weekly@mag.spam-b.example"];

/** 140 conversations, every 3rd from a promo sender (interleaved). */
function pool(): mail.MailMessageListItem[] {
  return Array.from({ length: 140 }, (_, i) => {
    const email = i % 3 === 1 ? SPAM[i % 2]! : `friend${i}@ok.example`;
    return {
      id: `m${String(1000 - i)}`,
      messageId: `<m${i}@x>`,
      threadId: `thr_${i}`,
      from: { email, name: email.split("@")[0] },
      to: [{ email: "me@developershub.jp" }],
      subject: `件名 ${i}`,
      snippet: "本文",
      receivedAt: new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString(),
      read: true,
      mine: true,
    };
  });
}

/** A fake gateway that applies the block list server-side, like folders.ts. */
function fakeServer(initialBlocks: string[]) {
  const all = pool();
  const blocks = new Set(initialBlocks);
  const isBlocked = (e: string) => blocks.has(e) || [...blocks].some((b) => !b.includes("@") && (e.endsWith(`@${b}`) || e.endsWith(`.${b}`)));
  const listInbox = vi.fn().mockImplementation((q: InboxQuery = {}) => {
    const view = all.filter((m) => (q.folder === "blocked" ? isBlocked(m.from.email) : !isBlocked(m.from.email)));
    const start = q.cursor ? view.findIndex((m) => m.threadId === q.cursor) + 1 : 0;
    const items = view.slice(start, start + (q.limit ?? 50));
    return Promise.resolve({
      items: items.map((m) => (isBlocked(m.from.email) ? { ...m, blocked: true } : m)),
      nextCursor: start + items.length < view.length ? items.at(-1)!.threadId : null,
      total: view.length,
    });
  });
  const api: MailApi = {
    send: vi.fn(),
    listInbox,
    getMessage: vi.fn(),
    getThread: vi.fn().mockImplementation((id: string) => {
      const m = all.find((x) => x.threadId === id)!;
      return Promise.resolve({ id, messages: [{ ...m, textBody: "本文", ...(isBlocked(m.from.email) ? { blocked: true } : {}) }] });
    }),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    listSent: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSent: vi.fn(),
    downloadAttachment: vi.fn(),
    listFlags: vi.fn().mockResolvedValue([]),
    setFlags: vi.fn().mockImplementation((threadId: string) => Promise.resolve({ threadId, starred: false, archived: false, trashed: false, purged: false, noReplyAt: null })),
    schedule: vi.fn(),
    listScheduled: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getScheduled: vi.fn(),
    updateScheduled: vi.fn(),
    cancelScheduled: vi.fn(),
    listBlocks: vi.fn().mockImplementation(() =>
      Promise.resolve([...blocks].map((v) => ({ value: v, kind: v.includes("@") ? "address" : "domain", createdAt: "2026-10-01T00:00:00.000Z" }))),
    ),
    addBlock: vi.fn().mockImplementation((req: mail.MailSenderBlockRequest) => {
      const value = req.kind === "domain" ? req.value.split("@").pop()! : req.value;
      blocks.add(value);
      return Promise.resolve({ value, kind: req.kind ?? "address", createdAt: "2026-10-30T00:00:00.000Z" });
    }),
    removeBlock: vi.fn().mockImplementation((value: string) => {
      blocks.delete(value);
      return Promise.resolve({ value, blocked: false });
    }),
    counts: vi.fn().mockResolvedValue({
      inbox: { total: 93, unread: 77 },
      mine: { total: 93, unread: 77 },
      others: { total: 0, unread: 0 },
      starred: { total: 0, unread: 0 },
      archive: { total: 0, unread: 0 },
      trash: { total: 0, unread: 0 },
      blocked: { total: 47, unread: 0 },
    } satisfies mail.MailFolderCounts),
  };
  return { api, listInbox };
}

const rows = () => screen.queryAllByTestId("fe2-mail-inbox-item");

afterEach(() => localStorage.clear());

describe("folder paging without client-side gaps", () => {
  it("renders every conversation of a server page (50 rows) with the total, though senders are blocked", async () => {
    const { api, listInbox } = fakeServer(SPAM);
    render(<MailApiProvider value={api}><GmailApp /></MailApiProvider>);
    await waitFor(() => expect(rows()).toHaveLength(50));
    expect(listInbox).toHaveBeenCalledWith(expect.objectContaining({ folder: "inbox", limit: 50 }));
    expect(screen.getByTestId("fe2-mail-page-range")).toHaveTextContent("1–50 / 93");

    await userEvent.click(screen.getByTestId("fe2-mail-page-next"));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-page-range")).toHaveTextContent("51–93 / 93"));
    expect(rows()).toHaveLength(43);
  });

  it("badges come from GET /mail/counts (whole mailbox), not the loaded page", async () => {
    const { api } = fakeServer(SPAM);
    render(<MailApiProvider value={api}><GmailApp /></MailApiProvider>);
    await waitFor(() => expect(within(screen.getByTestId("fe2-mail-folder-inbox")).getByText("77")).toBeInTheDocument());
    expect(screen.getByTestId("fe2-mail-folder-blocked").textContent).toBe("ブロック済み");
  });

  it("blocking from a thread re-files it at once, then refills the page back to 50", async () => {
    const { api, listInbox } = fakeServer([]);
    render(<MailApiProvider value={api}><GmailApp /></MailApiProvider>);
    await waitFor(() => expect(rows()).toHaveLength(50));
    await userEvent.click(screen.getByText("件名 1")); // from promo@shop-a.example? i=1 → SPAM[1]
    await userEvent.click(await screen.findByTestId("fe2-mail-more-trigger"));
    await userEvent.click(screen.getByTestId("fe2-mail-block-domain"));
    await userEvent.click(within(await screen.findByTestId("fe2-mail-block-confirm")).getByRole("button", { name: "ブロックする" }));
    await userEvent.click(screen.getByTestId("fe2-mail-thread-back"));
    const calls = listInbox.mock.calls.length;
    // Optimistically gone; then the short page is re-fetched and full again.
    await waitFor(() => expect(listInbox.mock.calls.length).toBeGreaterThan(calls), { timeout: 3000 });
    await waitFor(() => expect(rows()).toHaveLength(50));
  });

  it("ブロック済み pages the blocked view from the server", async () => {
    const { api, listInbox } = fakeServer(SPAM);
    render(<MailApiProvider value={api}><GmailApp /></MailApiProvider>);
    await waitFor(() => expect(rows()).toHaveLength(50));
    await userEvent.click(screen.getByTestId("fe2-mail-folder-blocked"));
    await waitFor(() => expect(listInbox).toHaveBeenLastCalledWith(expect.objectContaining({ folder: "blocked" })));
    await waitFor(() => expect(rows()).toHaveLength(47));
  });
});
