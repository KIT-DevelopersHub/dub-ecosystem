// #899 filters: the panel narrows the list through the gateway (GET /mail/messages + /sent with
// the filter keys), filters combine, active chips clear one filter or all, the URL keeps them
// (a remount restores them) and the model maps to/from the URL and the API.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { InboxQuery, MailApi, SentQuery } from "../../mailApi.tsx";
import { MailApiProvider } from "../../MailProvider.tsx";
import { GmailApp } from "../GmailApp.tsx";
import { describeFilters, knownAddresses, parseFilters, receivingAddresses, toApiFilters, writeFilters } from "./mailFilters.ts";

function item(id: string, subject: string, from: string, read: boolean): mail.MailMessageListItem {
  return {
    id,
    messageId: `<${id}@x>`,
    threadId: `thr_${id}`,
    from: { email: from },
    to: [{ email: "me@developershub.jp" }],
    subject,
    snippet: "…",
    receivedAt: "2026-08-01T00:00:00.000Z",
    read,
  };
}
const A = item("a", "Aからの未読", "alice@example.com", false);
const B = item("b", "Bからの既読", "bob@example.com", true);

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
    setReadState: vi.fn().mockResolvedValue(undefined),
    bulkAction: vi.fn().mockResolvedValue(undefined),
    listDrafts: vi.fn().mockResolvedValue([]),
    saveDraft: vi.fn().mockImplementation((id: string, d: object) => Promise.resolve({ ...d, id, updatedAt: "2026-01-01T00:00:00.000Z", attachments: [] })),
    deleteDraft: vi.fn().mockResolvedValue(undefined),
    addDraftAttachment: vi.fn().mockResolvedValue({ id: "datt", filename: "f", contentType: "text/plain", sizeBytes: 1 }),
    removeDraftAttachment: vi.fn().mockResolvedValue(undefined),
    listTemplates: vi.fn().mockResolvedValue([]),
    saveTemplate: vi.fn().mockImplementation((id: string, t: object) => Promise.resolve({ ...t, id, updatedAt: "2026-01-01T00:00:00.000Z" })),
    deleteTemplate: vi.fn().mockResolvedValue(undefined),
    listBlocks: vi.fn().mockResolvedValue([]),
    addBlock: vi.fn().mockImplementation((req: { value: string; kind?: "address" | "domain" }) => Promise.resolve({ value: req.value.toLowerCase(), kind: req.kind ?? "address", createdAt: "2026-01-01T00:00:00.000Z" })),
    getForward: vi.fn().mockResolvedValue({ target: null, status: "none", enabled: false, active: false, available: true, requestedAt: null, verifiedAt: null, lastResult: null, lastError: null, lastAt: null }),
    registerForward: vi.fn(),
    updateForward: vi.fn(),
    removeForward: vi.fn(),
    avatars: vi.fn().mockResolvedValue({ avatars: {} }),
    removeBlock: vi.fn().mockImplementation((value: string) => Promise.resolve({ value, blocked: false })),
    counts: vi.fn().mockRejectedValue(new Error("no counts")),
    ...over,
  };
}

afterEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

/** A gateway that applies unread / from itself, like mail-gateway does. */
function filteringInbox() {
  return vi.fn(async (q?: InboxQuery) => {
    let items = [A, B];
    if (q?.filters?.unread) items = items.filter((m) => m.read === (q.filters!.unread === "0"));
    if (q?.filters?.from) items = items.filter((m) => m.from.email === q.filters!.from);
    return { items, nextCursor: null };
  });
}

function renderApp(api: MailApi) {
  return render(
    <MailApiProvider value={api}>
      <GmailApp />
    </MailApiProvider>,
  );
}

describe("mail filters (#899)", () => {
  it("未読 narrows the list via the gateway, skips Sent, and is kept in the URL", async () => {
    const listInbox = filteringInbox();
    const listSent = vi.fn(async (_q?: SentQuery) => ({ items: [], nextCursor: null }));
    renderApp(fakeApi(listInbox, { listSent }));
    expect(await screen.findByText("Bからの既読")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("fe2-mail-filter-toggle"));
    fireEvent.click(await screen.findByTestId("fe2-mail-filter-read-unread"));
    await waitFor(() => expect(screen.queryByText("Bからの既読")).not.toBeInTheDocument());
    expect(await screen.findByText("Aからの未読")).toBeInTheDocument();
    expect(listInbox).toHaveBeenCalledWith(expect.objectContaining({ folder: "all", filters: { unread: "1" } }));
    // A sent message is never unread: Sent is not asked.
    expect(listSent.mock.calls.some((c) => c[0]?.filters)).toBe(false);
    expect(window.location.search).toBe("?read=unread");
    expect(within(screen.getByTestId("fe2-mail-filter-active")).getByText("未読")).toBeInTheDocument();
  });

  it("restores filters from the URL on load and combines them", async () => {
    window.history.replaceState(null, "", "/mail?read=read&from=bob%40example.com&open=x");
    const listInbox = filteringInbox();
    renderApp(fakeApi(listInbox));
    expect(await screen.findByText("Bからの既読")).toBeInTheDocument();
    expect(screen.queryByText("Aからの未読")).not.toBeInTheDocument();
    expect(listInbox).toHaveBeenCalledWith(expect.objectContaining({ filters: { unread: "0", from: "bob@example.com" } }));
    // Other params survive; the filters stay.
    expect(new URLSearchParams(window.location.search).get("open")).toBe("x");
    expect(new URLSearchParams(window.location.search).get("from")).toBe("bob@example.com");
  });

  it("an active chip's × removes that filter; すべて解除 clears all and returns to the folder", async () => {
    window.history.replaceState(null, "", "/mail?read=unread&attachment=1");
    renderApp(fakeApi(filteringInbox()));
    const chips = await screen.findByTestId("fe2-mail-filter-active");
    fireEvent.click(within(screen.getByTestId("fe2-mail-filter-active-attachment")).getByRole("button"));
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-filter-active-attachment")).not.toBeInTheDocument());
    expect(window.location.search).toBe("?read=unread");
    expect(chips).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("fe2-mail-filter-active-clear"));
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-filter-active")).not.toBeInTheDocument());
    expect(window.location.search).toBe("");
    expect(await screen.findByText("Bからの既読")).toBeInTheDocument();
  });

  it("shows the empty state (not the inbox) when nothing matches", async () => {
    window.history.replaceState(null, "", "/mail?from=nobody%40example.com");
    renderApp(fakeApi(filteringInbox()));
    expect(await screen.findByTestId("fe2-mail-search-empty")).toHaveTextContent("絞り込み条件に一致するメールはありません");
  });
});

describe("mailFilters model", () => {
  it("round-trips the URL and drops malformed values", () => {
    const f = parseFilters("?read=unread&dir=sent&from=A%40x.com&to=bad&starred=1&attachment=1&after=2026-03-01&before=2026-13-99&mailbox=info%40d.jp&open=1");
    expect(f).toEqual({ read: "unread", direction: "sent", from: "a@x.com", starred: true, attachment: true, after: "2026-03-01", mailbox: "info@d.jp" });
    expect(writeFilters("?open=1", f)).toBe("?open=1&read=unread&dir=sent&from=a%40x.com&mailbox=info%40d.jp&starred=1&attachment=1&after=2026-03-01");
    expect(writeFilters("?read=read&open=1", {})).toBe("?open=1");
  });

  it("maps to the API per list: 受信 skips Sent, 送信 skips the inbox, dates become local-day bounds", () => {
    expect(toApiFilters({ direction: "received" }).sent).toBeNull();
    expect(toApiFilters({ direction: "sent" }).inbox).toBeNull();
    expect(toApiFilters({ read: "unread" }).sent).toBeNull();
    const { inbox } = toApiFilters({ after: "2026-03-01", before: "2026-03-01", attachment: true, starred: true, read: "read" });
    expect(inbox).toEqual({
      after: new Date(2026, 2, 1).toISOString(),
      before: new Date(2026, 2, 2).toISOString(),
      hasAttachment: "1",
      starred: "1",
      unread: "0",
    });
  });

  it("describes active filters and collects pickable addresses", () => {
    expect(describeFilters({ read: "unread", from: "a@x.com", after: "2026-03-05" }, () => "Aさん").map((c) => c.label)).toEqual(["未読", "差出人: Aさん", "3/5 以降"]);
    const threads = [
      {
        id: "t",
        subject: "s",
        folder: "inbox" as const,
        starred: false,
        labels: [],
        messages: [{ id: "m", from: { email: "Z@x.com", name: "Z" }, to: [{ email: "info@developershub.jp" }], cc: [{ email: "c@y.com" }], date: "d", body: "", read: true }],
      },
    ];
    expect(knownAddresses(threads, { email: "me@developershub.jp" }).map((a) => a.email)).toEqual(["c@y.com", "info@developershub.jp", "me@developershub.jp", "z@x.com"]);
    expect(receivingAddresses(threads, "me@developershub.jp")).toEqual(["info@developershub.jp", "me@developershub.jp"]);
    // Viewer address unknown: the domain the received mail is addressed to; Cc is not a receiving address.
    expect(receivingAddresses(threads, "")).toEqual(["info@developershub.jp"]);
  });
});
