// Tests for the Gmail-style mail experience. The store reducer (stars, archive+undo,
// trash, send, read-on-open, compose lifecycle, HYDRATE/sync) is exercised against the
// TEST-ONLY demo fixtures (mailModel.fixtures.ts) — the shipped store starts empty. The
// render tests drive the assembled 3-pane UI through a fake MailApi, proving the UI now
// shows LIVE gateway data (inbox + Sent) rather than any bundled demo threads.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { MAIL_POLL_MS } from "./useMailSync.tsx";
import { reducer, initialMailState, type MailState } from "./useMailStore.tsx";
import { hasSharedMail, inFolder, sharedRecipientLabel, threadMine, threadUnread, type MailThreadModel } from "./mailModel.ts";
import {
  DEMO_INBOX_ITEMS,
  DEMO_INBOX_THREAD,
  DEMO_LABELS,
  DEMO_ME,
  DEMO_SENT_DETAIL,
  DEMO_SENT_ITEMS,
  DEMO_THREADS,
} from "./mailModel.fixtures.ts";

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
    schedule: vi.fn().mockResolvedValue({ id: "sch", scheduledAt: "2099-01-01T00:00:00.000Z", status: "scheduled" }),
    listScheduled: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getScheduled: vi.fn().mockResolvedValue({ id: "sch", to: [], subject: "s", snippet: "", scheduledAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", status: "scheduled", textBody: "b" }),
    updateScheduled: vi.fn().mockResolvedValue({ id: "sch", to: [], subject: "s", snippet: "", scheduledAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", status: "scheduled", textBody: "b" }),
    cancelScheduled: vi.fn().mockResolvedValue({ id: "sch", status: "canceled" }),
    ...over,
  };
}

function wrap(ui: ReactNode, api: MailApi = fakeApi()): JSX.Element {
  return <MailApiProvider value={api}>{ui}</MailApiProvider>;
}

// Reducer tests run against the demo fixtures (the shipped initial state is empty).
const base = (): MailState => ({
  ...initialMailState,
  me: DEMO_ME,
  labels: DEMO_LABELS,
  threads: DEMO_THREADS.map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m })) })),
  checked: new Set(),
  composes: [],
  undo: null,
});

describe("mail store reducer", () => {
  it("ships an empty initial state (no bundled demo data)", () => {
    expect(initialMailState.threads).toHaveLength(0);
    expect(initialMailState.labels).toHaveLength(0);
  });

  it("toggles a thread star", () => {
    const s = base();
    const id = s.threads[0]!.id;
    const before = s.threads[0]!.starred;
    const next = reducer(s, { type: "TOGGLE_STAR", id });
    expect(next.threads.find((t) => t.id === id)!.starred).toBe(!before);
  });

  it("APPLY_FLAGS restores server-persisted star/archive/trash (改善#8)", () => {
    const s = base();
    const inbox = s.threads.find((t) => t.folder === "inbox")!;
    const other = s.threads.find((t) => t.folder === "inbox" && t.id !== inbox.id) ?? s.threads[0]!;
    const next = reducer(s, {
      type: "APPLY_FLAGS",
      flags: [
        { threadId: inbox.id, starred: true, archived: false, trashed: false, purged: false },
        { threadId: other.id, starred: false, archived: true, trashed: false, purged: false },
      ],
    });
    expect(next.threads.find((t) => t.id === inbox.id)!.starred).toBe(true);
    expect(next.threads.find((t) => t.id === other.id)!.folder).toBe("archive");
  });

  it("never changes the read state of another account's mail (view-only)", () => {
    const s = base();
    const t = s.threads.find((x) => threadUnread(x))!;
    const others: MailState = {
      ...s,
      threads: s.threads.map((x) => (x.id === t.id ? { ...x, messages: x.messages.map((m) => ({ ...m, read: false, mine: false })) } : x)),
    };
    expect(threadUnread(others.threads.find((x) => x.id === t.id)!)).toBe(false);
    const opened = reducer(others, { type: "OPEN_THREAD", id: t.id });
    const read = reducer(opened, { type: "SET_READ", ids: [t.id], read: true });
    expect(read.threads.find((x) => x.id === t.id)!.messages.every((m) => !m.read)).toBe(true);
  });

  it("marks every message read when a thread is opened", () => {
    const s = base();
    const unread = s.threads.find((t) => threadUnread(t))!;
    const next = reducer(s, { type: "OPEN_THREAD", id: unread.id });
    expect(next.openThreadId).toBe(unread.id);
    expect(threadUnread(next.threads.find((t) => t.id === unread.id)!)).toBe(false);
  });

  it("archive moves out of inbox and UNDO restores the prior state", () => {
    const s = base();
    const id = s.threads.find((t) => t.folder === "inbox")!.id;
    const archived = reducer(s, { type: "ARCHIVE", ids: [id] });
    expect(archived.threads.find((t) => t.id === id)!.folder).toBe("archive");
    expect(archived.undo).not.toBeNull();
    const restored = reducer(archived, { type: "UNDO" });
    expect(restored.threads.find((t) => t.id === id)!.folder).toBe("inbox");
    expect(restored.undo).toBeNull();
  });

  it("trash moves a thread to the trash folder", () => {
    const s = base();
    const id = s.threads.find((t) => t.folder === "inbox")!.id;
    const next = reducer(s, { type: "TRASH", ids: [id] });
    expect(next.threads.find((t) => t.id === id)!.folder).toBe("trash");
  });

  it("restore moves a trashed received thread back to the inbox (with undo)", () => {
    const s = base();
    const id = s.threads.find((t) => t.folder === "inbox")!.id;
    const trashed = reducer(s, { type: "TRASH", ids: [id] });
    expect(trashed.threads.find((t) => t.id === id)!.folder).toBe("trash");
    const restored = reducer(trashed, { type: "RESTORE", ids: [id] });
    expect(restored.threads.find((t) => t.id === id)!.folder).toBe("inbox");
    // Undo bounces it straight back to Trash.
    expect(restored.undo).not.toBeNull();
    expect(reducer(restored, { type: "UNDO" }).threads.find((t) => t.id === id)!.folder).toBe("trash");
  });

  it("restore returns an all-outbound (sent) thread to the Sent folder, not the inbox", () => {
    const s = base();
    const sent = reducer(s, { type: "SEND", to: [{ email: "a@x.com" }], cc: [], subject: "Hi", body: "yo" });
    const id = sent.threads[0]!.id;
    const trashed = reducer(sent, { type: "TRASH", ids: [id] });
    const restored = reducer(trashed, { type: "RESTORE", ids: [id] });
    expect(restored.threads.find((t) => t.id === id)!.folder).toBe("sent");
  });

  it("完全に削除 (PURGE) marks a thread purged (per-user hide) with NO undo — irreversible", () => {
    const s = base();
    const id = s.threads.find((t) => t.folder === "inbox")!.id;
    const trashed = reducer(s, { type: "TRASH", ids: [id] });
    const purged = reducer(trashed, { type: "PURGE", ids: [id] });
    expect(purged.threads.find((t) => t.id === id)!.purged).toBe(true);
    // No restore path: PURGE leaves no undo snapshot (the user cannot bring it back).
    expect(purged.undo).toBeNull();
    // The row is NOT removed from the store (view-only hide; server keeps the body).
    expect(purged.threads.find((t) => t.id === id)).toBeTruthy();
  });

  it("APPLY_FLAGS restores a persisted purge so it stays hidden after a reload (per-user)", () => {
    const s = base();
    const id = s.threads.find((t) => t.folder === "inbox")!.id;
    const next = reducer(s, {
      type: "APPLY_FLAGS",
      flags: [{ threadId: id, starred: false, archived: false, trashed: false, purged: true }],
    });
    expect(next.threads.find((t) => t.id === id)!.purged).toBe(true);
  });

  it("SEND prepends a new thread into the Sent folder", () => {
    const s = base();
    const n = s.threads.length;
    const next = reducer(s, { type: "SEND", to: [{ email: "a@x.com" }], cc: [], subject: "Hi", body: "yo" });
    expect(next.threads.length).toBe(n + 1);
    expect(next.threads[0]!.folder).toBe("sent");
    expect(next.threads[0]!.subject).toBe("Hi");
  });

  it("HYDRATE replaces threads with the server view", () => {
    const s = base();
    const next = reducer(s, { type: "HYDRATE", threads: [{ id: "srv", subject: "S", folder: "inbox", starred: false, labels: [], messages: [] }] });
    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]!.id).toBe("srv");
  });

  it("REQUEST_SYNC bumps the sync nonce", () => {
    const s = base();
    expect(reducer(s, { type: "REQUEST_SYNC" }).syncNonce).toBe(s.syncNonce + 1);
  });

  it("SET_THREAD_MESSAGES fills a thread's full bodies", () => {
    const s = base();
    const id = s.threads[0]!.id;
    const msg = { id: "full", from: { email: "x@y.z" }, to: [], date: "2026-01-01T00:00:00.000Z", body: "FULL BODY", read: true };
    const next = reducer(s, { type: "SET_THREAD_MESSAGES", threadId: id, messages: [msg] });
    expect(next.threads.find((t) => t.id === id)!.messages).toEqual([msg]);
  });

  it("compose windows open, update and close", () => {
    let s = reducer(base(), { type: "OPEN_COMPOSE", compose: { subject: "Draft" } });
    expect(s.composes).toHaveLength(1);
    const id = s.composes[0]!.id;
    s = reducer(s, { type: "UPDATE_COMPOSE", id, patch: { body: "typed" } });
    expect(s.composes[0]!.body).toBe("typed");
    s = reducer(s, { type: "CLOSE_COMPOSE", id });
    expect(s.composes).toHaveLength(0);
  });

  it("maximizing one compose demotes any other maximized window", () => {
    let s = reducer(base(), { type: "OPEN_COMPOSE", compose: { maximized: true } });
    s = reducer(s, { type: "OPEN_COMPOSE", compose: { maximized: true } });
    expect(s.composes.filter((c) => c.maximized)).toHaveLength(1);
  });
});

describe("GmailApp (hydrates from the gateway)", () => {
  it("renders the folder nav and rows hydrated from the live inbox", async () => {
    render(wrap(<GmailApp />));
    expect(screen.getByTestId("fe2-mail-folder-inbox")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-folder-sent")).toBeInTheDocument();
    const rows = await screen.findAllByTestId("fe2-mail-inbox-item");
    expect(rows.length).toBe(DEMO_INBOX_ITEMS.length);
    // The live subject shows; no bundled demo thread ("キックオフ") leaks into the bundle.
    expect(screen.getByText("登壇のご相談")).toBeInTheDocument();
    expect(screen.queryByText(/キックオフ/)).not.toBeInTheDocument();
  });

  it("shows the empty state when the gateway returns no mail (no demo fallback)", async () => {
    const api = fakeApi({
      listInbox: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      listSent: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    });
    render(wrap(<GmailApp />, api));
    expect(await screen.findByTestId("fe2-mail-inbox-empty")).toBeInTheDocument();
    expect(screen.queryAllByTestId("fe2-mail-inbox-item")).toHaveLength(0);
  });

  // Regression: mail that arrives after the inbox loaded never appeared until a full page
  // reload (the 更新 button only cleared checks, and nothing re-fetched).
  it("更新 re-fetches the inbox so newly arrived mail appears without a reload", async () => {
    const listInbox = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValue({ items: DEMO_INBOX_ITEMS, nextCursor: null });
    render(wrap(<GmailApp />, fakeApi({ listInbox, listSent: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) })));
    expect(await screen.findByTestId("fe2-mail-inbox-empty")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("fe2-mail-refresh"));
    await waitFor(() => expect(screen.getAllByTestId("fe2-mail-inbox-item").length).toBeGreaterThan(0));
    expect(listInbox).toHaveBeenCalledTimes(2);
  });

  it("re-fetches the inbox in the background on an interval and when the tab becomes visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const listInbox = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
      render(wrap(<GmailApp />, fakeApi({ listInbox })));
      await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(1));
      await act(async () => {
        vi.advanceTimersByTime(MAIL_POLL_MS);
      });
      await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(2));
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(3));
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a floating compose window from the compose button", async () => {
    render(wrap(<GmailApp />));
    await userEvent.click(screen.getByTestId("fe2-mail-compose-open"));
    expect(screen.getByTestId("fe2-mail-compose-window")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-compose-to")).toBeInTheDocument();
  });

  it("opens the reading pane (full body) when a row is clicked", async () => {
    render(wrap(<GmailApp />));
    const firstRow = (await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!;
    await userEvent.click(firstRow);
    expect(screen.getByTestId("fe2-mail-thread")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-reply")).toBeInTheDocument();
    // getThread's full body replaces the snippet in the reading pane.
    await waitFor(() => expect(screen.getByText(/相談させてください/)).toBeInTheDocument());
  });

  it("persists read-state to the server when an unread thread is opened", async () => {
    const api = fakeApi();
    render(wrap(<GmailApp />, api));
    const firstRow = (await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!; // mailin_1 is unread
    await userEvent.click(firstRow);
    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith("mailin_1"));
  });

  it("shows the Sent folder from GET /mail/sent", async () => {
    render(wrap(<GmailApp />));
    await screen.findAllByTestId("fe2-mail-inbox-item"); // wait for hydration
    await userEvent.click(screen.getByTestId("fe2-mail-folder-sent"));
    const list = screen.getByTestId("fe2-mail-inbox");
    await waitFor(() => expect(within(list).getAllByTestId("fe2-mail-inbox-item").length).toBeGreaterThan(0));
    expect(within(list).getByText("こんばんは")).toBeInTheDocument();
  });

  it("re-fetches the Sent folder after a send (persists across reload)", async () => {
    const api = fakeApi();
    render(wrap(<GmailApp />, api));
    await screen.findAllByTestId("fe2-mail-inbox-item");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-open"));
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "dest@example.com");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "件名");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    // send() posts to the gateway, then REQUEST_SYNC re-reads GET /mail/sent.
    expect(api.send).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((api.listSent as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1));
  });

  it("inline reply POSTs to the gateway with In-Reply-To (was a silent no-op before)", async () => {
    const api = fakeApi();
    render(wrap(<GmailApp />, api));
    const firstRow = (await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!; // mailin_1 / thr_in_1
    await userEvent.click(firstRow);
    // Wait for getThread to fill the body (so `last.messageId` is the real Message-Id).
    await waitFor(() => expect(screen.getByText(/相談させてください/)).toBeInTheDocument());
    await userEvent.type(screen.getByTestId("fe2-mail-inline-reply"), "承知しました、対応します。");
    await userEvent.click(screen.getByTestId("fe2-mail-inline-send"));
    // The reply is actually SENT (previously ADD_MESSAGE only → nothing left the client).
    expect(api.send).toHaveBeenCalledTimes(1);
    const sent = (api.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.inReplyTo).toBe("<in1@developershub.jp>"); // threads against the parent
    expect(sent.subject).toBe("Re: 登壇のご相談");
    expect(sent.to).toEqual([{ email: "hanako@example.com", name: "山田 花子" }]);
    expect(sent.textBody).toContain("承知しました");
    // Re-syncs so the sent reply is server-backed after the round-trip.
    await waitFor(() => expect((api.listSent as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1));
  });

  it("keeps a sent reply visible in its conversation and replies to the external correspondent (not ourselves)", async () => {
    // Sent folder carries our reply, threaded (threadId) into the received conversation.
    const api = fakeApi({
      listInbox: vi.fn().mockResolvedValue({ items: [DEMO_INBOX_ITEMS[0]!], nextCursor: null }),
      listSent: vi.fn().mockResolvedValue({
        items: [
          {
            id: "sent_r",
            from: { email: "info@developershub.jp" },
            to: [{ email: "hanako@example.com", name: "山田 花子" }],
            subject: "Re: 登壇のご相談",
            snippet: "了解しました。",
            sentAt: "2026-08-10T02:00:00.000Z",
            provider: "resend",
            status: "sent",
            threadId: "thr_in_1",
          },
        ],
        nextCursor: null,
      }),
    });
    render(wrap(<GmailApp />, api));
    const firstRow = (await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!;
    await userEvent.click(firstRow);
    // getThread returns received-only; the folded reply must survive the refresh.
    await waitFor(() => expect(screen.getByText("了解しました。")).toBeInTheDocument());
    // Replying targets the external correspondent (hanako), never our own info@ reply.
    await userEvent.click(screen.getByTestId("fe2-mail-reply"));
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    const sent = (api.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.to).toEqual([{ email: "hanako@example.com", name: "山田 花子" }]);
    expect(sent.inReplyTo).toBe("<in1@developershub.jp>");
  });

  it("reply button opens a compose that sends In-Reply-To", async () => {
    const api = fakeApi();
    render(wrap(<GmailApp />, api));
    const firstRow = (await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!;
    await userEvent.click(firstRow);
    await waitFor(() => expect(screen.getByText(/相談させてください/)).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("fe2-mail-reply"));
    expect(screen.getByTestId("fe2-mail-compose-window")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    expect(api.send).toHaveBeenCalledTimes(1);
    const sent = (api.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sent.inReplyTo).toBe("<in1@developershub.jp>");
    expect(sent.subject).toBe("Re: 登壇のご相談");
  });

  it("nudges an unreplied received thread; the banner reply reuses compose and the reply clears it", async () => {
    // Gateway echo: once we send, GET /sent returns the reply threaded into thr_in_1.
    let replied = false;
    const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString();
    const reply: mail.MailSentListItem = {
      id: "sent_r", to: [{ email: "hanako@example.com" }], subject: "Re: 登壇のご相談", snippet: "了解しました。",
      sentAt: new Date().toISOString(), provider: "resend", status: "sent", threadId: "thr_in_1",
    };
    const api = fakeApi({
      // Read, received 4 days ago → inside the 3..14 day window (list + opened detail agree).
      listInbox: vi.fn().mockResolvedValue({ items: [{ ...DEMO_INBOX_ITEMS[0]!, read: true, receivedAt: fourDaysAgo }], nextCursor: null }),
      getThread: vi.fn().mockResolvedValue({
        ...DEMO_INBOX_THREAD,
        messages: DEMO_INBOX_THREAD.messages.map((m) => ({ ...m, read: true, receivedAt: fourDaysAgo })),
      }),
      send: vi.fn().mockImplementation(() => {
        replied = true;
        return Promise.resolve({ messageId: "m", provider: "resend", acceptedAt: "t" });
      }),
      listSent: vi.fn().mockImplementation(() => Promise.resolve({ items: replied ? [reply] : [], nextCursor: null })),
    });
    render(wrap(<GmailApp />, api));
    const row = (await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!;
    expect(within(row).getByTestId("fe2-mail-reply-nudge")).toHaveTextContent("4日前・未返信");
    await userEvent.click(row);
    await waitFor(() => expect(screen.getByText(/相談させてください/)).toBeInTheDocument());
    expect(screen.getByTestId("fe2-mail-reply-nudge-banner")).toHaveTextContent("4日前に受信したメールにまだ返信していません");
    await userEvent.click(screen.getByTestId("fe2-mail-reply-nudge-reply"));
    expect(screen.getByTestId("fe2-mail-compose-window")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    expect((api.send as ReturnType<typeof vi.fn>).mock.calls[0]![0].inReplyTo).toBe("<in1@developershub.jp>");
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-reply-nudge-banner")).not.toBeInTheDocument());
  });

  it("pins unreplied mail above newer arrivals so it can't get buried; the group collapses", async () => {
    const day = 86_400_000;
    const api = fakeApi({
      listInbox: vi.fn().mockResolvedValue({
        items: [
          { ...DEMO_INBOX_ITEMS[0]!, read: false, receivedAt: new Date(Date.now() - 3_600_000).toISOString() },
          { ...DEMO_INBOX_ITEMS[1]!, read: true, receivedAt: new Date(Date.now() - 5 * day).toISOString() },
        ],
        nextCursor: null,
      }),
    });
    render(wrap(<GmailApp />, api));
    await screen.findAllByTestId("fe2-mail-inbox-item");
    expect(screen.getByTestId("fe2-mail-nudge-section")).toHaveTextContent("返信待ち 1件");
    expect(screen.getByTestId("fe2-mail-rest-section")).toHaveTextContent("その他");
    const rows = screen.getAllByTestId("fe2-mail-inbox-item");
    expect(within(rows[0]!).getByText("会場下見の日程")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("登壇のご相談")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("fe2-mail-nudge-section-toggle"));
    expect(screen.getAllByTestId("fe2-mail-inbox-item")).toHaveLength(1);
    expect(screen.queryByText("会場下見の日程")).not.toBeInTheDocument();
    // Select-all only reaches rows on screen, never the collapsed group.
    await userEvent.click(screen.getByTestId("fe2-mail-select-all"));
    expect(screen.getByText("1件を選択中")).toBeInTheDocument();

    // Other folders are never split.
    await userEvent.click(screen.getByTestId("fe2-mail-folder-sent"));
    expect(screen.queryByTestId("fe2-mail-nudge-section")).not.toBeInTheDocument();
  });

  it("返信不要 from the banner drops the thread out of 返信待ち; 元に戻す brings it back (persisted both ways)", async () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString();
    const api = fakeApi({
      listInbox: vi.fn().mockResolvedValue({ items: [{ ...DEMO_INBOX_ITEMS[0]!, read: true, receivedAt: fourDaysAgo }], nextCursor: null }),
      getThread: vi.fn().mockResolvedValue({
        ...DEMO_INBOX_THREAD,
        messages: DEMO_INBOX_THREAD.messages.map((m) => ({ ...m, read: true, receivedAt: fourDaysAgo })),
      }),
    });
    render(wrap(<GmailApp />, api));
    await waitFor(() => expect(api.listFlags).toHaveBeenCalled());
    const row = (await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!;
    expect(screen.getByTestId("fe2-mail-nudge-section")).toHaveTextContent("返信待ち 1件");
    await userEvent.click(row);
    await waitFor(() => expect(screen.getByTestId("fe2-mail-reply-nudge-banner")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("fe2-mail-reply-nudge-dismiss"));
    // Optimistic: the banner vanishes at once (the list's group is covered by the row test).
    expect(screen.queryByTestId("fe2-mail-reply-nudge-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-undo")).toHaveTextContent("返信不要にしました");
    await waitFor(() =>
      expect((api.setFlags as ReturnType<typeof vi.fn>).mock.calls.some((c) => (c[1] as { noReply?: boolean }).noReply === true)).toBe(true),
    );
    await userEvent.click(within(screen.getByTestId("fe2-mail-undo")).getByText("元に戻す"));
    expect(screen.getByTestId("fe2-mail-reply-nudge-banner")).toBeInTheDocument();
    await waitFor(() =>
      expect((api.setFlags as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]).toMatchObject({ noReply: false }),
    );
  });

  it("返信不要 from a 返信待ち row does not open the thread and survives a reload via listFlags", async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const items = [{ ...DEMO_INBOX_ITEMS[0]!, read: true, receivedAt: fiveDaysAgo }];
    const api = fakeApi({ listInbox: vi.fn().mockResolvedValue({ items, nextCursor: null }) });
    const { unmount } = render(wrap(<GmailApp />, api));
    await waitFor(() => expect(api.listFlags).toHaveBeenCalled());
    const btn = await screen.findByTestId("fe2-mail-reply-nudge-dismiss-row");
    expect(btn).toHaveAttribute("aria-label", "返信不要にする");
    await userEvent.click(btn);
    expect(screen.queryByTestId("fe2-mail-thread")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-mail-nudge-section")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("fe2-mail-inbox-item")).toHaveLength(1);
    expect(screen.queryByTestId("fe2-mail-reply-nudge")).not.toBeInTheDocument();
    // 元に戻す from the toast puts it back in 返信待ち.
    await userEvent.click(within(screen.getByTestId("fe2-mail-undo")).getByText("元に戻す"));
    expect(screen.getByTestId("fe2-mail-nudge-section")).toHaveTextContent("返信待ち 1件");
    unmount();

    // Reload: the server returns the stamp → still no nudge.
    const threadId = items[0]!.threadId;
    const reloaded = fakeApi({
      listInbox: vi.fn().mockResolvedValue({ items, nextCursor: null }),
      listFlags: vi.fn().mockResolvedValue([{ threadId, starred: false, archived: false, trashed: false, purged: false, noReplyAt: new Date().toISOString() }]),
    });
    render(wrap(<GmailApp />, reloaded));
    await waitFor(() => expect(reloaded.listFlags).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-nudge-section")).not.toBeInTheDocument());
    expect(screen.getAllByTestId("fe2-mail-inbox-item")).toHaveLength(1);
  });

  it("toggles a star from a list row", async () => {
    render(wrap(<GmailApp />));
    const firstStar = (await screen.findAllByTestId("fe2-mail-star"))[0]!;
    await userEvent.click(firstStar);
    expect(screen.getAllByTestId("fe2-mail-inbox-item").length).toBeGreaterThan(0);
  });

  it("persists a star to the server so it survives a reload (改善#8)", async () => {
    const api = fakeApi();
    render(wrap(<GmailApp />, api));
    // Flags are loaded on hydrate (arming the persist baseline).
    await waitFor(() => expect(api.listFlags).toHaveBeenCalled());
    const firstStar = (await screen.findAllByTestId("fe2-mail-star"))[0]!;
    await userEvent.click(firstStar);
    // The optimistic star change is POSTed to the gateway (server-backed, reload-safe).
    await waitFor(() => expect(api.setFlags).toHaveBeenCalled());
    const call = (api.setFlags as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[1]).toMatchObject({ starred: true });
  });

  it("restores a persisted star from GET /mail/flags on load (改善#8)", async () => {
    // The gateway reports the first inbox thread as starred; the UI must reflect it.
    const api = fakeApi({
      listFlags: vi.fn().mockResolvedValue([{ threadId: "thr_in_1", starred: true, archived: false, trashed: false, purged: false }]),
    });
    render(wrap(<GmailApp />, api));
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-starred"));
    const list = screen.getByTestId("fe2-mail-inbox");
    await waitFor(() => expect(within(list).getAllByTestId("fe2-mail-inbox-item").length).toBeGreaterThan(0));
  });

  it("完全に削除 from Trash hides the conversation and POSTs purged:true (per-user, no delete)", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    // The gateway reports thr_in_1 as trashed → it lives in the viewer's Trash.
    const api = fakeApi({
      listFlags: vi.fn().mockResolvedValue([{ threadId: "thr_in_1", starred: false, archived: false, trashed: true, purged: false }]),
    });
    render(wrap(<GmailApp />, api));
    await waitFor(() => expect(api.listFlags).toHaveBeenCalled());
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-trash"));
    const list = screen.getByTestId("fe2-mail-inbox");
    await waitFor(() => expect(within(list).getAllByTestId("fe2-mail-inbox-item").length).toBe(1));
    // Select the trashed thread, then bulk 完全に削除 (confirm dialog is accepted).
    await userEvent.click(screen.getByTestId("fe2-mail-select-all"));
    await userEvent.click(screen.getByTestId("fe2-mail-purge-bulk"));
    expect(confirmSpy).toHaveBeenCalled();
    // Gone from THIS viewer's Trash (optimistic hide) …
    await waitFor(() => expect(within(list).queryAllByTestId("fe2-mail-inbox-item").length).toBe(0));
    // … and persisted as purged:true so it survives a reload (the body is never deleted).
    await waitFor(() => {
      const call = (api.setFlags as ReturnType<typeof vi.fn>).mock.calls.find((c) => (c[1] as { purged?: boolean })?.purged === true);
      expect(call).toBeTruthy();
    });
    confirmSpy.mockRestore();
  });

  it("does NOT 完全に削除 when the confirm dialog is cancelled", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const api = fakeApi({
      listFlags: vi.fn().mockResolvedValue([{ threadId: "thr_in_1", starred: false, archived: false, trashed: true, purged: false }]),
    });
    render(wrap(<GmailApp />, api));
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-trash"));
    const list = screen.getByTestId("fe2-mail-inbox");
    await waitFor(() => expect(within(list).getAllByTestId("fe2-mail-inbox-item").length).toBe(1));
    await userEvent.click(screen.getByTestId("fe2-mail-select-all"));
    await userEvent.click(screen.getByTestId("fe2-mail-purge-bulk"));
    // Cancelled: the thread stays, and nothing is POSTed as purged.
    expect(within(list).getAllByTestId("fe2-mail-inbox-item").length).toBe(1);
    const purgeCall = (api.setFlags as ReturnType<typeof vi.fn>).mock.calls.find((c) => (c[1] as { purged?: boolean })?.purged === true);
    expect(purgeCall).toBeUndefined();
    confirmSpy.mockRestore();
  });

  it("does not offer 完全に削除 outside Trash (inbox rows have no purge action)", async () => {
    render(wrap(<GmailApp />));
    await screen.findAllByTestId("fe2-mail-inbox-item");
    await userEvent.click(screen.getByTestId("fe2-mail-select-all"));
    // Inbox bulk toolbar has archive/trash but never a 完全に削除.
    expect(screen.queryByTestId("fe2-mail-purge-bulk")).not.toBeInTheDocument();
  });

  it("shows attachments in the 3-pane reading view and downloads a stored one (改善#1)", async () => {
    const api = fakeApi();
    render(wrap(<GmailApp />, api));
    const firstRow = (await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!;
    await userEvent.click(firstRow);
    // getThread fills the full detail, which now carries attachment metadata.
    await waitFor(() => expect(screen.getByTestId("fe2-mail-attachments")).toBeInTheDocument());
    const chips = screen.getAllByTestId("fe2-mail-attachment");
    expect(chips).toHaveLength(2);
    // The stored file downloads via the session-authorized MailApi (kind=messages, inbound).
    const stored = screen.getByRole("button", { name: /資料\.pdf をダウンロード/ });
    await userEvent.click(stored);
    await waitFor(() => expect(api.downloadAttachment).toHaveBeenCalledWith("messages", "mailin_1", "att_ok"));
  });

  describe("recipient summary + details dialog (Gmail の「詳細を表示」)", () => {
    const withMeta: mail.MailThread = {
      ...DEMO_INBOX_THREAD,
      messages: [
        {
          ...DEMO_INBOX_THREAD.messages[0]!,
          cc: [{ email: "yuki@example.com", name: "伊藤 由紀" }, { email: "office@example.net" }],
          headerMeta: {
            replyTo: [{ email: "kanji@example.com", name: "幹事" }],
            deliveredTo: "info@developershub.jp",
            mailedBy: "mail.example.com",
            signedBy: "example.com",
            tls: true,
          },
        },
      ],
    };
    const openFirst = async (api: MailApi): Promise<void> => {
      render(wrap(<GmailApp />, api));
      await userEvent.click((await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!);
    };

    it("summarises To + Cc on one line with the delivered-to address as 自分", async () => {
      await openFirst(fakeApi({ getThread: vi.fn().mockResolvedValue(withMeta) }));
      const toggle = await screen.findByTestId("fe2-mail-details-toggle");
      await waitFor(() => expect(toggle).toHaveTextContent("宛先: 自分, 伊藤 由紀, office@example.net"));
      expect(screen.queryByTestId("fe2-mail-details")).toBeNull();
    });

    it("opens a dialog with every field, own address marked, without collapsing the message", async () => {
      await openFirst(fakeApi({ getThread: vi.fn().mockResolvedValue(withMeta) }));
      await waitFor(() => expect(screen.getByTestId("fe2-mail-details-toggle")).toHaveTextContent("自分"));
      await userEvent.click(screen.getByTestId("fe2-mail-details-toggle"));
      const dialog = await screen.findByTestId("fe2-mail-details");
      const row = (label: string): HTMLElement => within(dialog).getByTestId(`fe2-mail-details-row-${label}`);
      expect(row("差出人")).toHaveTextContent("山田 花子 <hanako@example.com>");
      expect(row("返信先")).toHaveTextContent("幹事 <kanji@example.com>");
      expect(row("宛先")).toHaveTextContent("info@developershub.jp（自分）");
      expect(row("Cc")).toHaveTextContent("伊藤 由紀 <yuki@example.com>");
      expect(row("Cc")).toHaveTextContent("office@example.net");
      expect(row("件名")).toHaveTextContent("登壇のご相談");
      expect(row("送信元")).toHaveTextContent("mail.example.com");
      expect(row("署名元")).toHaveTextContent("example.com");
      expect(row("セキュリティ")).toHaveTextContent("標準的な暗号化（TLS）");
      // The body stays open behind the dialog (the toggle must not fold the message).
      expect(screen.getByTestId("fe2-mail-body-text")).toBeInTheDocument();
    });

    it("copies a single Cc address and all Cc addresses at once", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      await openFirst(fakeApi({ getThread: vi.fn().mockResolvedValue(withMeta) }));
      await waitFor(() => expect(screen.getByTestId("fe2-mail-details-toggle")).toHaveTextContent("自分"));
      await userEvent.click(screen.getByTestId("fe2-mail-details-toggle"));
      const dialog = await screen.findByTestId("fe2-mail-details");
      await userEvent.click(within(dialog).getByRole("button", { name: "yuki@example.comをコピー" }));
      expect(writeText).toHaveBeenLastCalledWith("yuki@example.com");
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "yuki@example.comをコピーしました" })).toBeInTheDocument());
      await userEvent.click(within(dialog).getByTestId("fe2-mail-details-copy-all-cc"));
      expect(writeText).toHaveBeenLastCalledWith("yuki@example.com, office@example.net");
    });

    it("hides rows the message does not carry (pre-0013 mail: no Reply-To / security)", async () => {
      await openFirst(fakeApi());
      await userEvent.click(await screen.findByTestId("fe2-mail-details-toggle"));
      const dialog = await screen.findByTestId("fe2-mail-details");
      expect(within(dialog).queryByTestId("fe2-mail-details-row-返信先")).toBeNull();
      expect(within(dialog).queryByTestId("fe2-mail-details-row-セキュリティ")).toBeNull();
      expect(within(dialog).getByTestId("fe2-mail-details-row-Cc")).toHaveTextContent("伊藤 由紀");
    });

    it("replies to the Reply-To address (RFC 5322), not the From", async () => {
      await openFirst(fakeApi({ getThread: vi.fn().mockResolvedValue(withMeta) }));
      await waitFor(() => expect(screen.getByPlaceholderText("幹事 に返信…")).toBeInTheDocument());
    });
  });

  it("surfaces an oversize attachment as a disabled chip instead of dropping it silently (改善#2)", async () => {
    const api = fakeApi();
    render(wrap(<GmailApp />, api));
    const firstRow = (await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!;
    await userEvent.click(firstRow);
    await waitFor(() => expect(screen.getByTestId("fe2-mail-attachments")).toBeInTheDocument());
    const dropped = screen.getByRole("button", { name: /動画\.mp4/ });
    expect(dropped).toBeDisabled();
    expect(dropped).toHaveTextContent(/サイズ超過/);
    await userEvent.click(dropped).catch(() => undefined);
    expect(api.downloadAttachment).not.toHaveBeenCalled();
  });

  // P25: fe2 Gmail ThreadList archive/delete exit animation. Row must slide out
  // (translateX + opacity) and collapse (height/border) for EXIT_MS before the
  // underlying ARCHIVE/TRASH dispatch actually removes it from the visible list.
  describe("archive/delete exit animation (P25)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps the archived row mounted (marked leaving) until EXIT_MS elapses, then removes it", async () => {
      const api = fakeApi();
      render(wrap(<GmailApp />, api));
      const rows = await screen.findAllByTestId("fe2-mail-inbox-item");
      const initialCount = rows.length;
      const firstRow = rows[0]!;
      fireEvent.mouseEnter(firstRow);
      const archiveBtn = screen.getByTestId("fe2-mail-archive");

      vi.useFakeTimers();
      fireEvent.click(archiveBtn);

      // Not removed yet — still mounted, just marked leaving so it can animate out.
      expect(screen.getAllByTestId("fe2-mail-inbox-item")).toHaveLength(initialCount);
      expect(firstRow).toHaveAttribute("data-leaving", "true");

      act(() => {
        vi.advanceTimersByTime(200);
      });

      // EXIT_MS elapsed: the real ARCHIVE dispatch has landed, dropping it from the inbox view.
      expect(screen.getAllByTestId("fe2-mail-inbox-item")).toHaveLength(initialCount - 1);
    });

    it("keeps the trashed row mounted (marked leaving) until EXIT_MS elapses, then removes it", async () => {
      const api = fakeApi();
      render(wrap(<GmailApp />, api));
      const rows = await screen.findAllByTestId("fe2-mail-inbox-item");
      const initialCount = rows.length;
      const firstRow = rows[0]!;
      fireEvent.mouseEnter(firstRow);
      const trashBtn = screen.getByTestId("fe2-mail-trash");

      vi.useFakeTimers();
      fireEvent.click(trashBtn);

      expect(screen.getAllByTestId("fe2-mail-inbox-item")).toHaveLength(initialCount);
      expect(firstRow).toHaveAttribute("data-leaving", "true");

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(screen.getAllByTestId("fe2-mail-inbox-item")).toHaveLength(initialCount - 1);
    });

    it("removes the row immediately with no leaving window under prefers-reduced-motion", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia;

      try {
        const api = fakeApi();
        render(wrap(<GmailApp />, api));
        const rows = await screen.findAllByTestId("fe2-mail-inbox-item");
        const initialCount = rows.length;
        const firstRow = rows[0]!;
        fireEvent.mouseEnter(firstRow);
        const archiveBtn = screen.getByTestId("fe2-mail-archive");

        fireEvent.click(archiveBtn);

        // No leaving window at all — removed synchronously, matching today's instant behavior.
        expect(screen.getAllByTestId("fe2-mail-inbox-item")).toHaveLength(initialCount - 1);
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });
  });
});

describe("自分宛て / 自分宛て以外 (role-shared mail)", () => {
  const msg = (over: Partial<MailThreadModel["messages"][number]> = {}): MailThreadModel["messages"][number] => ({
    id: "m", from: { email: "a@x.jp" }, to: [{ email: "suzuki@developershub.jp", name: "鈴木 一郎" }], date: "2026-08-01T00:00:00Z", body: "b", read: false, ...over,
  });
  const thread = (id: string, messages: MailThreadModel["messages"], folder: MailThreadModel["folder"] = "inbox"): MailThreadModel => ({
    id, subject: id, folder, starred: false, labels: [], messages,
  });

  it("threadMine: absent/true = mine, all-false = not mine, sent-only = mine", () => {
    expect(threadMine(thread("a", [msg()]))).toBe(true);
    expect(threadMine(thread("b", [msg({ mine: false })]))).toBe(false);
    expect(threadMine(thread("c", [msg({ mine: false }), msg({ id: "m2", mine: true })]))).toBe(true);
    // our own reply folded into a shared thread does not make it mine
    expect(threadMine(thread("d", [msg({ mine: false }), msg({ id: "r", outbound: true })]))).toBe(false);
    expect(threadMine(thread("e", [msg({ outbound: true })], "sent"))).toBe(true);
  });

  it("inFolder: mine/others split the inbox only", () => {
    const own = thread("own", [msg()]);
    const shared = thread("shared", [msg({ mine: false })]);
    const archived = thread("arch", [msg({ mine: false })], "archive");
    expect(inFolder(own, "mine")).toBe(true);
    expect(inFolder(own, "others")).toBe(false);
    expect(inFolder(shared, "others")).toBe(true);
    expect(inFolder(shared, "mine")).toBe(false);
    expect(inFolder(archived, "others")).toBe(false);
    expect(hasSharedMail([own])).toBe(false);
    expect(hasSharedMail([own, shared])).toBe(true);
  });

  it("labels a shared thread by its recipient, falling back to 共有メール", () => {
    expect(sharedRecipientLabel(thread("s", [msg({ mine: false })]))).toBe("鈴木 一郎 宛て");
    expect(sharedRecipientLabel(thread("s", [msg({ mine: false, to: [] })]))).toBe("共有メール");
  });

  it("hides the entries when every thread is mine (no change for ordinary users)", async () => {
    render(wrap(<GmailApp />));
    await screen.findAllByTestId("fe2-mail-inbox-item");
    expect(screen.queryByTestId("fe2-mail-folder-mine")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-mail-folder-others")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-mail-shared-chip")).not.toBeInTheDocument();
  });

  it("shows the entries + a recipient chip when role-shared mail is visible", async () => {
    const shared = { ...DEMO_INBOX_ITEMS[0]!, id: "shared_1", threadId: "thr_shared", subject: "協賛プランのお見積り依頼", to: [{ email: "suzuki@developershub.jp", name: "鈴木 一郎" }], mine: false };
    const api = fakeApi({ listInbox: vi.fn().mockResolvedValue({ items: [...DEMO_INBOX_ITEMS, shared], nextCursor: null }) });
    render(wrap(<GmailApp />, api));
    expect(await screen.findByTestId("fe2-mail-folder-others")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-folder-mine")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-shared-chip")).toHaveTextContent("鈴木 一郎 宛て");

    await userEvent.click(screen.getByTestId("fe2-mail-folder-others"));
    const list = screen.getByTestId("fe2-mail-inbox");
    const rows = within(list).getAllByTestId("fe2-mail-inbox-item");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("協賛プランのお見積り依頼")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("fe2-mail-folder-mine"));
    expect(within(screen.getByTestId("fe2-mail-inbox")).getAllByTestId("fe2-mail-inbox-item")).toHaveLength(DEMO_INBOX_ITEMS.length);
  });
});

describe("Gmail-style pagination (cursor-paged folder list)", () => {
  // n received items whose ids/subjects encode the page, so assertions can tell pages apart.
  const pageItems = (page: number, n: number): mail.MailMessageListItem[] =>
    Array.from({ length: n }, (_, i) => ({
      ...DEMO_INBOX_ITEMS[1]!,
      id: `p${page}_${i}`,
      threadId: `thr_p${page}_${i}`,
      subject: `page${page}-${i}`,
    }));
  // Page 1 (no cursor) → 50 items + cursor "c2"; page 2 ("c2") → 3 items, end of list.
  const pagedInbox = () =>
    vi.fn().mockImplementation((q?: { cursor?: string }) =>
      Promise.resolve(q?.cursor === "c2" ? { items: pageItems(2, 3), nextCursor: null } : { items: pageItems(1, 50), nextCursor: "c2" }),
    );
  const noSent = () => vi.fn().mockResolvedValue({ items: [], nextCursor: null });

  it("shows the 1–50 range, pages forward/back via the cursor stack, and disables at both ends", async () => {
    const listInbox = pagedInbox();
    render(wrap(<GmailApp />, fakeApi({ listInbox, listSent: noSent() })));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-page-range")).toHaveTextContent("1–50"));
    expect(screen.getByTestId("fe2-mail-page-prev")).toBeDisabled();
    expect(screen.getByTestId("fe2-mail-page-next")).toBeEnabled();

    await userEvent.click(screen.getByTestId("fe2-mail-page-next"));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-page-range")).toHaveTextContent("51–53"));
    expect(listInbox).toHaveBeenLastCalledWith({ limit: 50, cursor: "c2" });
    expect(screen.getAllByTestId("fe2-mail-inbox-item")).toHaveLength(3);
    expect(screen.getByTestId("fe2-mail-page-next")).toBeDisabled();
    expect(screen.getByTestId("fe2-mail-page-prev")).toBeEnabled();

    await userEvent.click(screen.getByTestId("fe2-mail-page-prev"));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-page-range")).toHaveTextContent("1–50"));
    expect(listInbox).toHaveBeenLastCalledWith({ limit: 50 });
    expect(screen.getByTestId("fe2-mail-page-prev")).toBeDisabled();
  });

  it("shows a skeleton (not the empty state) while a page loads", async () => {
    let release: (v: unknown) => void = () => undefined;
    const listInbox = vi.fn().mockImplementation((q?: { cursor?: string }) =>
      q?.cursor === "c2" ? new Promise((r) => (release = r)) : Promise.resolve({ items: pageItems(1, 50), nextCursor: "c2" }),
    );
    render(wrap(<GmailApp />, fakeApi({ listInbox, listSent: noSent() })));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-page-next")).toBeEnabled());
    await userEvent.click(screen.getByTestId("fe2-mail-page-next"));
    expect(screen.getByTestId("fe2-mail-list-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-mail-inbox-empty")).toBeNull();
    expect(screen.getByTestId("fe2-mail-page-next")).toBeDisabled();
    await act(async () => release({ items: pageItems(2, 3), nextCursor: null }));
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-list-loading")).toBeNull());
  });

  it("background refetch refreshes the CURRENT page (keeps the cursor)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const listInbox = pagedInbox();
      render(wrap(<GmailApp />, fakeApi({ listInbox, listSent: noSent() })));
      await waitFor(() => expect(screen.getByTestId("fe2-mail-page-next")).toBeEnabled());
      await userEvent.click(screen.getByTestId("fe2-mail-page-next"));
      await waitFor(() => expect(screen.getByTestId("fe2-mail-page-range")).toHaveTextContent("51–53"));
      const calls = listInbox.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(MAIL_POLL_MS);
      });
      await waitFor(() => expect(listInbox.mock.calls.length).toBe(calls + 1));
      expect(listInbox).toHaveBeenLastCalledWith({ limit: 50, cursor: "c2" });
      expect(screen.getByTestId("fe2-mail-page-range")).toHaveTextContent("51–53");
      expect(screen.queryByTestId("fe2-mail-list-loading")).toBeNull(); // no skeleton flicker
    } finally {
      vi.useRealTimers();
    }
  });

  it("switching folders returns to page 1; Sent pages its own list", async () => {
    const listInbox = pagedInbox();
    const listSent = vi.fn().mockResolvedValue({ items: DEMO_SENT_ITEMS, nextCursor: null });
    render(wrap(<GmailApp />, fakeApi({ listInbox, listSent })));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-page-next")).toBeEnabled());
    await userEvent.click(screen.getByTestId("fe2-mail-page-next"));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-page-range")).toHaveTextContent("51–53"));
    await userEvent.click(screen.getByTestId("fe2-mail-folder-sent"));
    await waitFor(() => expect(listInbox).toHaveBeenLastCalledWith({ limit: 50 }));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-page-range")).toHaveTextContent(`1–${DEMO_SENT_ITEMS.length}`));
    expect(screen.getByTestId("fe2-mail-page-next")).toBeDisabled();
  });

  it("reducer ignores next at the last page and prev at the first page", () => {
    const s = { ...initialMailState, listLoading: false };
    expect(reducer(s, { type: "PAGE_NEXT", source: "inbox" })).toBe(s);
    expect(reducer(s, { type: "PAGE_PREV", source: "inbox" })).toBe(s);
  });
});
