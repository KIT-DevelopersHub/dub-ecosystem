// Tests for the Gmail-style mail experience: the client store reducer (stars,
// archive+undo, trash, send, read-on-open, compose lifecycle) and a render smoke
// test of the assembled 3-pane UI (folders, dense rows, compose window, list↔
// reading-pane swap). All in-memory — no network.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { reducer, initialMailState, type MailState } from "./useMailStore.tsx";
import { threadUnread } from "./mailModel.ts";

function fakeApi(over: Partial<MailApi> = {}): MailApi {
  return {
    send: vi.fn().mockResolvedValue({ messageId: "m", provider: "ses", acceptedAt: "t" }),
    listInbox: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getMessage: vi.fn(),
    getThread: vi.fn(),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    ...over,
  };
}

function wrap(ui: ReactNode): JSX.Element {
  return <MailApiProvider value={fakeApi()}>{ui}</MailApiProvider>;
}

const base = (): MailState => ({ ...initialMailState, checked: new Set(), composes: [], undo: null });

describe("mail store reducer", () => {
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

describe("GmailApp", () => {
  it("renders the folder nav and dense demo rows", () => {
    render(wrap(<GmailApp />));
    expect(screen.getByTestId("fe2-mail-folder-inbox")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-folder-sent")).toBeInTheDocument();
    expect(screen.getAllByTestId("fe2-mail-inbox-item").length).toBeGreaterThan(0);
  });

  it("opens a floating compose window from the compose button", async () => {
    render(wrap(<GmailApp />));
    await userEvent.click(screen.getByTestId("fe2-mail-compose-open"));
    expect(screen.getByTestId("fe2-mail-compose-window")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-compose-to")).toBeInTheDocument();
  });

  it("opens the reading pane when a row is clicked", async () => {
    render(wrap(<GmailApp />));
    const firstRow = screen.getAllByTestId("fe2-mail-inbox-item")[0]!;
    await userEvent.click(firstRow);
    expect(screen.getByTestId("fe2-mail-thread")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-reply")).toBeInTheDocument();
  });

  it("switches folders from the sidebar", async () => {
    render(wrap(<GmailApp />));
    await userEvent.click(screen.getByTestId("fe2-mail-folder-sent"));
    const list = screen.getByTestId("fe2-mail-inbox");
    // Sent demo threads exist, so the list still has rows under the Sent view.
    expect(within(list).getAllByTestId("fe2-mail-inbox-item").length).toBeGreaterThan(0);
  });

  it("toggles a star from a list row", async () => {
    render(wrap(<GmailApp />));
    const firstStar = screen.getAllByTestId("fe2-mail-star")[0]!;
    // Should not throw and should keep the row present after toggling.
    await userEvent.click(firstStar);
    expect(screen.getAllByTestId("fe2-mail-inbox-item").length).toBeGreaterThan(0);
  });
});
