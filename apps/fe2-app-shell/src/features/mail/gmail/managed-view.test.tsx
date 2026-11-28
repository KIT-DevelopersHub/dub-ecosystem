// #942 自分の班・チームのメンバーのメールを読み取り専用で見る (UI): the 受信箱 switcher appears only
// when the server offers a range, switching reads that member's mailbox through its own read-only
// api, the 閲覧中 banner stays up, compose is gone, and nothing is written for the member.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import { createManagedMailApi, ReadOnlyMailboxError, type MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import type { ApiClient } from "../../../lib/api-client.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { initialMailState, readOnlyReducer, reducer, type MailAction } from "./useMailStore.tsx";

function fakeApi(over: Partial<MailApi> = {}): MailApi {
  return {
    send: vi.fn().mockResolvedValue({ messageId: "m", provider: "resend", acceptedAt: "t" }),
    listInbox: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getMessage: vi.fn(),
    getThread: vi.fn(),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    listSent: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSent: vi.fn(),
    downloadAttachment: vi.fn().mockResolvedValue(new Blob(["x"])),
    listFlags: vi.fn().mockResolvedValue([]),
    setFlags: vi.fn().mockResolvedValue({ threadId: "t", starred: false, archived: false, trashed: false, purged: false }),
    schedule: vi.fn().mockResolvedValue({ id: "sch", scheduledAt: "2099-01-01T00:00:00.000Z", status: "scheduled" }),
    listScheduled: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getScheduled: vi.fn().mockResolvedValue({ id: "sch", to: [], subject: "s", snippet: "", scheduledAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", status: "scheduled", textBody: "b" }),
    updateScheduled: vi.fn().mockResolvedValue({ id: "sch", to: [], subject: "s", snippet: "", scheduledAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", status: "scheduled", textBody: "b" }),
    cancelScheduled: vi.fn().mockResolvedValue({ id: "sch", status: "canceled" }),
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

const A1: mail.MailManagedMailbox = { userId: "usr_a1", name: "山田 花子", relation: "squad" };

const memberMessage: mail.MailMessageListItem = {
  id: "mailin_a1",
  messageId: "<a1@x>",
  threadId: "thr_a1",
  mailbox: "info",
  from: { email: "sponsor@partner.example", name: "協賛 担当" },
  to: [{ email: "a1@developershub.jp" }],
  subject: "協賛のご相談",
  snippet: "ご相談です",
  receivedAt: "2026-11-20T00:00:00.000Z",
  read: false,
} as mail.MailMessageListItem;

function setup() {
  const managed = fakeApi({ listInbox: vi.fn().mockResolvedValue({ items: [memberMessage], nextCursor: null }) });
  const own = fakeApi({
    listManagedMailboxes: vi.fn().mockResolvedValue([A1]),
    forManaged: vi.fn().mockReturnValue(managed),
  });
  render(
    <MailApiProvider value={own}>
      <GmailApp />
    </MailApiProvider>,
  );
  return { own, managed };
}

async function pick(testId: string): Promise<void> {
  await userEvent.click(await screen.findByTestId("fe2-mail-mailbox-select-trigger"));
  await userEvent.click(await screen.findByTestId(testId));
}

describe("受信箱の切り替え", () => {
  it("is not shown when the user manages nobody", async () => {
    render(
      <MailApiProvider value={fakeApi({ listManagedMailboxes: vi.fn().mockResolvedValue([]) })}>
        <GmailApp />
      </MailApiProvider>,
    );
    await screen.findByTestId("fe2-mail-compose-open");
    expect(screen.queryByTestId("fe2-mail-mailbox-switcher")).not.toBeInTheDocument();
  });

  it("opens a member's mailbox read-only, with the banner, and goes back", async () => {
    const { own, managed } = setup();
    await screen.findByTestId("fe2-mail-mailbox-switcher");
    expect(screen.queryByTestId("fe2-mail-viewing-banner")).not.toBeInTheDocument();

    await pick("fe2-mail-mailbox-option-usr_a1");
    expect(own.forManaged).toHaveBeenCalledWith("usr_a1");
    const banner = await screen.findByTestId("fe2-mail-viewing-banner");
    expect(banner).toHaveTextContent("山田 花子 さんのメールを閲覧中です（読み取り専用）");
    await waitFor(() => expect(managed.listInbox).toHaveBeenCalled());
    expect(await screen.findByText("協賛のご相談")).toBeInTheDocument();
    // No compose as the member; the generic 閲覧のみ notice is replaced by the banner.
    expect(screen.queryByTestId("fe2-mail-compose-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-mail-readonly")).not.toBeInTheDocument();

    await userEvent.click(within(banner).getByTestId("fe2-mail-viewing-exit"));
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-viewing-banner")).not.toBeInTheDocument());
    expect(await screen.findByTestId("fe2-mail-compose-open")).toBeInTheDocument();
  });

  it("writes nothing for the member while viewing", async () => {
    const { managed } = setup();
    await pick("fe2-mail-mailbox-option-usr_a1");
    await userEvent.click(await screen.findByText("協賛のご相談"));
    await new Promise((r) => setTimeout(r, 20));
    for (const write of ["markRead", "setReadState", "setFlags", "bulkAction", "send", "saveDraft"] as const) {
      expect(managed[write], write).not.toHaveBeenCalled();
    }
  });
});

describe("readOnlyReducer", () => {
  it("drops star / archive / trash / compose, keeps navigation", () => {
    const s = { ...initialMailState, folder: "inbox" as const };
    const actions: MailAction[] = [
      { type: "TOGGLE_STAR", id: "t" },
      { type: "ARCHIVE", ids: ["t"] },
      { type: "TRASH", ids: ["t"] },
      { type: "SET_READ", ids: ["t"], read: true },
      { type: "OPEN_COMPOSE", compose: {} },
    ];
    for (const action of actions) {
      expect(readOnlyReducer(s, action)).toBe(s);
    }
    expect(readOnlyReducer(s, { type: "SET_SEARCH", search: "x" })).toEqual(reducer(s, { type: "SET_SEARCH", search: "x" }));
  });

  it("opening a conversation keeps the owner's unread state", () => {
    const msg = { id: "m", read: false } as never;
    const s = { ...initialMailState, threads: [{ id: "t", messages: [msg] }] } as never as typeof initialMailState;
    const opened = readOnlyReducer(s, { type: "OPEN_THREAD", id: "t" });
    expect(opened.openThreadId).toBe("t");
    expect(opened.threads[0]!.messages[0]!.read).toBe(false);
  });
});

describe("createManagedMailApi", () => {
  it("reads under /mail/managed/:userId and rejects every write without a request", async () => {
    const request = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const download = vi.fn().mockResolvedValue(new Blob(["x"]));
    const api = createManagedMailApi({ request, download } as unknown as ApiClient, "usr_a1");
    await api.listInbox({ folder: "inbox" });
    await api.getThread("thr_1");
    await api.downloadAttachment("messages", "m1", "att1");
    expect(request.mock.calls.map((c) => (c[0] as { path: string }).path)).toEqual([
      "/api/v1/mail/managed/usr_a1/messages",
      "/api/v1/mail/managed/usr_a1/threads/thr_1",
    ]);
    expect(download).toHaveBeenCalledWith("/api/v1/mail/managed/usr_a1/messages/m1/attachments/att1");
    request.mockClear();
    await expect(api.markRead("m1")).rejects.toBeInstanceOf(ReadOnlyMailboxError);
    await expect(api.send({ to: [], subject: "s", textBody: "b" })).rejects.toBeInstanceOf(ReadOnlyMailboxError);
    await expect(api.setFlags("t", { starred: true })).rejects.toBeInstanceOf(ReadOnlyMailboxError);
    expect(request).not.toHaveBeenCalled();
  });
});
