// Tests for the Gmail-style mail experience. The store reducer (stars, archive+undo,
// trash, send, read-on-open, compose lifecycle, HYDRATE/sync) is exercised against the
// TEST-ONLY demo fixtures (mailModel.fixtures.ts) — the shipped store starts empty. The
// render tests drive the assembled 3-pane UI through a fake MailApi, proving the UI now
// shows LIVE gateway data (inbox + Sent) rather than any bundled demo threads.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { reducer, initialMailState, type MailState } from "./useMailStore.tsx";
import { threadUnread } from "./mailModel.ts";
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
    markUnread: vi.fn().mockResolvedValue({ read: false }),
    listSent: vi.fn().mockResolvedValue({ items: DEMO_SENT_ITEMS, nextCursor: null }),
    getSent: vi.fn().mockResolvedValue(DEMO_SENT_DETAIL),
    downloadAttachment: vi.fn().mockResolvedValue(new Blob(["x"])),
    listFlags: vi.fn().mockResolvedValue([]),
    setFlags: vi.fn().mockImplementation((threadId: string, patch: Record<string, boolean>) =>
      Promise.resolve({ threadId, starred: false, archived: false, trashed: false, ...patch }),
    ),
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
        { threadId: inbox.id, starred: true, archived: false, trashed: false },
        { threadId: other.id, starred: false, archived: true, trashed: false },
      ],
    });
    expect(next.threads.find((t) => t.id === inbox.id)!.starred).toBe(true);
    expect(next.threads.find((t) => t.id === other.id)!.folder).toBe("archive");
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

  it("persists a mark-UNREAD to the server so it survives a reload", async () => {
    const api = fakeApi();
    render(wrap(<GmailApp />, api));
    await waitFor(() => expect(api.listInbox).toHaveBeenCalled());
    const rows = await screen.findAllByTestId("fe2-mail-inbox-item");
    const readRow = rows[1]!; // mailin_2 / thr_in_2 is READ → its hover action is "未読にする"
    await userEvent.hover(readRow);
    await userEvent.click(await within(readRow).findByRole("button", { name: "未読にする" }));
    // The optimistic unread flip is POSTed to the gateway (server-backed, reload-safe).
    await waitFor(() => expect(api.markUnread).toHaveBeenCalledWith("mailin_2"));
  });

  it("rolls the unread flip back and shows a toast when the server rejects it", async () => {
    const api = fakeApi({ markUnread: vi.fn().mockRejectedValue(new Error("boom")) });
    render(wrap(<GmailApp />, api));
    await waitFor(() => expect(api.listInbox).toHaveBeenCalled());
    const rows = await screen.findAllByTestId("fe2-mail-inbox-item");
    const readRow = rows[1]!; // mailin_2 / thr_in_2 is READ
    await userEvent.hover(readRow);
    await userEvent.click(await within(readRow).findByRole("button", { name: "未読にする" }));
    // The failed POST rolls the UI back (the row is read again → hover shows "未読にする")
    // and surfaces an error toast.
    await waitFor(() => expect(screen.getByTestId("fe2-mail-toast")).toBeInTheDocument());
    await userEvent.hover(readRow);
    expect(await within(readRow).findByRole("button", { name: "未読にする" })).toBeInTheDocument();
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
      listFlags: vi.fn().mockResolvedValue([{ threadId: "thr_in_1", starred: true, archived: false, trashed: false }]),
    });
    render(wrap(<GmailApp />, api));
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-starred"));
    const list = screen.getByTestId("fe2-mail-inbox");
    await waitFor(() => expect(within(list).getAllByTestId("fe2-mail-inbox-item").length).toBeGreaterThan(0));
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
});
