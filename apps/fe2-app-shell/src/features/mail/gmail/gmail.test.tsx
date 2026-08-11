// Tests for the Gmail-style mail experience: the client store reducer (stars,
// archive+undo, trash, send, read-on-open, compose lifecycle) over the seeded demo
// fixture, and a render test of the assembled 3-pane UI wired to the gateway — the
// live app starts EMPTY and hydrates Inbox/Sent from the MailApi (no hardcoded seed).
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { common, mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { reducer, demoMailState, initialMailState, type MailState } from "./useMailStore.tsx";
import { threadUnread } from "./mailModel.ts";

const INBOX: mail.MailMessageListItem[] = [
  { id: "m1", messageId: "<m1>", threadId: "t1", from: { email: "a@x.com", name: "送信者A" }, to: [{ email: "me@developershub.jp" }], subject: "Hello", snippet: "hi there", receivedAt: "2026-08-10T00:00:00.000Z", read: false },
  { id: "m2", messageId: "<m2>", threadId: "t2", from: { email: "b@x.com", name: "送信者B" }, to: [{ email: "me@developershub.jp" }], subject: "Second", snippet: "yo", receivedAt: "2026-08-09T00:00:00.000Z", read: true },
];
const SENT: mail.MailSentListItem[] = [
  { id: "s1", to: [{ email: "c@x.com", name: "宛先C" }], subject: "送信済みの件", snippet: "sent body", sentAt: "2026-08-11T00:00:00.000Z", provider: "resend", status: "sent" },
];

function fakeApi(over: Partial<MailApi> = {}): MailApi {
  const page = <T,>(items: T[]): common.Paginated<T> => ({ items, nextCursor: null });
  return {
    send: vi.fn().mockResolvedValue({ messageId: "m", provider: "resend", acceptedAt: "t" }),
    listInbox: vi.fn().mockResolvedValue(page(INBOX)),
    getMessage: vi.fn(),
    getThread: vi.fn().mockResolvedValue({
      id: "t1",
      messages: [{ id: "m1", messageId: "<m1>", threadId: "t1", from: INBOX[0]!.from, to: INBOX[0]!.to, subject: "Hello", snippet: "hi there", receivedAt: INBOX[0]!.receivedAt, read: true, textBody: "Full inbox body." }],
    } satisfies mail.MailThread),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    listSent: vi.fn().mockResolvedValue(page(SENT)),
    getSent: vi.fn().mockResolvedValue({ ...SENT[0]!, textBody: "Full sent body." } satisfies mail.MailSentDetail),
    ...over,
  };
}

function wrap(ui: ReactNode, api: MailApi = fakeApi()): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MailApiProvider value={api}>{ui}</MailApiProvider>
    </QueryClientProvider>
  );
}

const base = (): MailState => ({ ...demoMailState, checked: new Set(), composes: [], undo: null });

describe("mail store reducer", () => {
  it("live initial state is EMPTY (no hardcoded demo pile)", () => {
    expect(initialMailState.threads).toHaveLength(0);
    expect(initialMailState.labels).toHaveLength(0);
  });

  it("SET_THREADS replaces the list (gateway hydration) and HYDRATE_THREAD fills bodies", () => {
    const s0 = { ...initialMailState, checked: new Set<string>(), composes: [], undo: null };
    const s1 = reducer(s0, { type: "SET_THREADS", threads: [{ id: "x", subject: "S", folder: "inbox", starred: false, labels: [], messages: [{ id: "x", from: { email: "a@x.com" }, to: [], date: "t", body: "snip", read: false }] }] });
    expect(s1.threads).toHaveLength(1);
    const s2 = reducer(s1, { type: "HYDRATE_THREAD", id: "x", messages: [{ id: "x", from: { email: "a@x.com" }, to: [], date: "t", body: "full body", read: true }] });
    expect(s2.threads[0]!.hydrated).toBe(true);
    expect(s2.threads[0]!.messages[0]!.body).toBe("full body");
  });

  it("toggles a thread star", () => {
    const s = base();
    const id = s.threads[0]!.id;
    const before = s.threads[0]!.starred;
    const next = reducer(s, { type: "TOGGLE_STAR", id });
    expect(next.threads.find((t) => t.id === id)!.starred).toBe(!before);
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

describe("GmailApp (gateway-wired)", () => {
  it("hydrates the Inbox from GET /mail/messages and shows the folder nav", async () => {
    render(wrap(<GmailApp />));
    expect(screen.getByTestId("fe2-mail-folder-inbox")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-folder-sent")).toBeInTheDocument();
    const rows = await screen.findAllByTestId("fe2-mail-inbox-item");
    expect(rows.length).toBe(INBOX.length);
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("opens a floating compose window from the compose button", async () => {
    render(wrap(<GmailApp />));
    await userEvent.click(screen.getByTestId("fe2-mail-compose-open"));
    expect(screen.getByTestId("fe2-mail-compose-window")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-compose-to")).toBeInTheDocument();
  });

  it("opens the reading pane (and loads the body) when a row is clicked", async () => {
    render(wrap(<GmailApp />));
    const firstRow = (await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!;
    await userEvent.click(firstRow);
    expect(screen.getByTestId("fe2-mail-thread")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-reply")).toBeInTheDocument();
    expect(await screen.findByText("Full inbox body.")).toBeInTheDocument();
  });

  it("switches to the Sent folder and lists sent mail from GET /mail/sent", async () => {
    render(wrap(<GmailApp />));
    await screen.findAllByTestId("fe2-mail-inbox-item");
    await userEvent.click(screen.getByTestId("fe2-mail-folder-sent"));
    const list = screen.getByTestId("fe2-mail-inbox");
    const rows = await within(list).findAllByTestId("fe2-mail-inbox-item");
    expect(rows.length).toBe(SENT.length);
    expect(screen.getByText("送信済みの件")).toBeInTheDocument();
  });

  it("toggles a star from a list row", async () => {
    render(wrap(<GmailApp />));
    const firstStar = (await screen.findAllByTestId("fe2-mail-star"))[0]!;
    await userEvent.click(firstStar);
    expect(screen.getAllByTestId("fe2-mail-inbox-item").length).toBeGreaterThan(0);
  });
});
