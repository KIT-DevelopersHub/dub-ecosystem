// Server-side search: typing in the box (debounced) queries GET /mail/messages?q= and
// GET /mail/sent?q=, renders the matches (even mail outside the loaded page / matched only
// by body), shows a skeleton while loading, 見つかりませんでした when nothing matches, pages
// with さらに読み込む, and clearing the box returns to the normal list.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { InboxQuery, MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { initialMailState, reducer } from "./useMailStore.tsx";

function item(id: string, subject: string, from: mail.MailAddress, snippet = "…"): mail.MailMessageListItem {
  return {
    id,
    messageId: `<${id}@x>`,
    threadId: `thr_${id}`,
    from,
    to: [{ email: "me@developershub.jp" }],
    subject,
    snippet,
    receivedAt: "2026-08-01T00:00:00.000Z",
    read: true,
  };
}
const RECENT = item("recent", "最近のメール", { email: "a@example.com", name: "Aさん" });
const OLD = item("old", "お見積りのご案内", { email: "info@zenryoku.example", name: "全力エージェンシー" }, "いつもお世話になっております");

function fakeApi(listInbox: MailApi["listInbox"], over: Partial<MailApi> = {}): MailApi {
  return {
    send: vi.fn(),
    listInbox,
    getMessage: vi.fn(),
    getThread: vi.fn().mockResolvedValue({ id: "t", messages: [] }),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    listSent: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSent: vi.fn(),
    downloadAttachment: vi.fn(),
    listFlags: vi.fn().mockResolvedValue([]),
    setFlags: vi.fn().mockResolvedValue({ threadId: "t", starred: false, archived: false, trashed: false, purged: false }),
    schedule: vi.fn(),
    listScheduled: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getScheduled: vi.fn(),
    updateScheduled: vi.fn(),
    cancelScheduled: vi.fn(),
    ...over,
  };
}

afterEach(() => localStorage.clear());

const searchCalls = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map((c) => c[0] as InboxQuery | undefined).filter((q) => q?.q !== undefined);

function renderApp(api: MailApi): void {
  render(
    <MailApiProvider value={api}>
      <GmailApp />
    </MailApiProvider>,
  );
}

describe("server-side mail search", () => {
  it("debounces typing into ONE server call per list and renders matches outside the loaded page", async () => {
    const listInbox = vi.fn(async (q?: InboxQuery) => ({ items: q?.q ? [OLD] : [RECENT], nextCursor: null }));
    const listSent = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    renderApp(fakeApi(listInbox, { listSent }));
    expect(await screen.findByText("最近のメール")).toBeInTheDocument();

    await userEvent.type(screen.getByTestId("fe2-mail-search"), "全力エージェンシー");
    expect(await screen.findByText("お見積りのご案内")).toBeInTheDocument();
    // Only the settled query hit the server (no per-keystroke calls).
    expect(searchCalls(listInbox)).toEqual([{ q: "全力エージェンシー", limit: 50 }]);
    expect(searchCalls(listSent)).toEqual([{ q: "全力エージェンシー", limit: 50 }]);
    expect(screen.queryByText("最近のメール")).toBeNull(); // pre-filter drops the non-match
  });

  it("renders a body-only server match the client snippet filter would miss, with a skeleton while loading", async () => {
    const listInbox = vi.fn(async (q?: InboxQuery) => ({ items: q?.q ? [OLD] : [RECENT, OLD], nextCursor: null }));
    renderApp(fakeApi(listInbox));
    await screen.findByText("最近のメール");
    fireEvent.change(screen.getByTestId("fe2-mail-search"), { target: { value: "ZR-2026-0042" } });
    // Loading skeleton while the server answers (nothing matches the client pre-filter).
    expect(screen.getByTestId("fe2-mail-search-loading")).toBeInTheDocument();
    expect(await screen.findByText("お見積りのご案内")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-mail-search-loading")).toBeNull();
  });

  it("shows 見つかりませんでした when the server finds nothing, and clearing restores the list", async () => {
    const listInbox = vi.fn(async (q?: InboxQuery) => ({ items: q?.q ? [] : [RECENT], nextCursor: null }));
    renderApp(fakeApi(listInbox));
    await screen.findByText("最近のメール");
    fireEvent.change(screen.getByTestId("fe2-mail-search"), { target: { value: "存在しない語" } });
    expect(await screen.findByTestId("fe2-mail-search-empty")).toHaveTextContent("見つかりませんでした");

    await userEvent.click(screen.getByLabelText("検索をクリア"));
    expect(await screen.findByText("最近のメール")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-mail-search-empty")).toBeNull();
  });

  it("pages results with さらに読み込む (cursor) and drops merged threads when cleared", async () => {
    const more = item("older", "さらに古い見積", { email: "info@zenryoku.example", name: "全力エージェンシー" });
    const listInbox = vi.fn(async (q?: InboxQuery) => {
      if (!q?.q) return { items: [RECENT], nextCursor: null };
      return q.cursor ? { items: [more], nextCursor: null } : { items: [OLD], nextCursor: "cur_1" };
    });
    renderApp(fakeApi(listInbox));
    await screen.findByText("最近のメール");
    fireEvent.change(screen.getByTestId("fe2-mail-search"), { target: { value: "全力" } });
    await screen.findByText("お見積りのご案内");
    await userEvent.click(await screen.findByTestId("fe2-mail-search-more"));
    expect(await screen.findByText("さらに古い見積")).toBeInTheDocument();
    expect(searchCalls(listInbox).at(-1)).toEqual({ q: "全力", limit: 50, cursor: "cur_1" });
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-search-more")).toBeNull());

    await userEvent.click(screen.getByLabelText("検索をクリア"));
    await screen.findByText("最近のメール");
    expect(screen.queryByText("お見積りのご案内")).toBeNull(); // not part of the inbox page
  });
});

describe("search reducer", () => {
  it("ignores a stale response for a query that is no longer in the box", () => {
    let s = reducer({ ...initialMailState, listLoading: false }, { type: "SET_SEARCH", search: "abc" });
    s = reducer(s, { type: "SET_SEARCH", search: "abcd" });
    const after = reducer(s, {
      type: "SEARCH_RESULTS",
      query: "abc",
      threads: [{ id: "x", subject: "x", folder: "inbox", starred: false, labels: [], messages: [] }],
      next: { inbox: null, sent: null },
    });
    expect(after).toBe(s);
  });

  it("keeps search-merged threads across a background HYDRATE while searching", () => {
    const t = { id: "old", subject: "old", folder: "inbox" as const, starred: false, labels: [], messages: [] };
    let s = reducer({ ...initialMailState, listLoading: false }, { type: "SET_SEARCH", search: "q" });
    s = reducer(s, { type: "SEARCH_RESULTS", query: "q", threads: [t], next: { inbox: null, sent: null } });
    s = reducer(s, { type: "HYDRATE", threads: [] });
    expect(s.threads.map((x) => x.id)).toEqual(["old"]);
    s = reducer(s, { type: "SET_SEARCH", search: "" });
    expect(s.threads).toEqual([]);
  });
});
