// 送信者ブロック: reading-pane menu + confirm, optimistic re-filing (受信トレイ ⇄ ブロック済み),
// banner unblock, the ブロック中のアドレス list (skeleton / empty / unblock), rollback on
// failure, and unread counts that ignore blocked mail.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { inFolder, senderMatcher, threadBlocked, type MailThreadModel } from "./mailModel.ts";

const at = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
const item = (id: string, email: string, name: string, subject: string, read = false): mail.MailMessageListItem => ({
  id,
  messageId: `<${id}@x>`,
  threadId: `thr_${id}`,
  from: { email, name },
  to: [{ email: "me@developershub.jp" }],
  subject,
  snippet: `${subject} の本文`,
  receivedAt: at(1),
  read,
  mine: true,
});
const INBOX = [
  item("spam", "news@deals.example", "お得情報", "【限定】セール"),
  item("friend", "hanako@example.com", "山田 花子", "登壇のご相談"),
  item("colleague", "staff@developershub.jp", "運営スタッフ", "会場下見"),
];
const threadOf = (it: mail.MailMessageListItem): mail.MailThread => ({
  id: it.threadId,
  messages: [{ ...it, textBody: `${it.subject} の本文` }],
});

function fakeApi(over: Partial<MailApi> = {}): MailApi {
  return {
    send: vi.fn().mockResolvedValue({ messageId: "m", provider: "resend", acceptedAt: "t" }),
    listInbox: vi.fn().mockResolvedValue({ items: INBOX, nextCursor: null }),
    getMessage: vi.fn(),
    getThread: vi.fn().mockImplementation((id: string) => Promise.resolve(threadOf(INBOX.find((i) => i.threadId === id)!))),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    listSent: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSent: vi.fn(),
    downloadAttachment: vi.fn().mockResolvedValue(new Blob(["x"])),
    listFlags: vi.fn().mockResolvedValue([]),
    setFlags: vi.fn().mockImplementation((threadId: string) => Promise.resolve({ threadId, starred: false, archived: false, trashed: false, purged: false, noReplyAt: null })),
    schedule: vi.fn(),
    listScheduled: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getScheduled: vi.fn(),
    updateScheduled: vi.fn(),
    cancelScheduled: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue([]),
    addBlock: vi.fn().mockImplementation((req: mail.MailSenderBlockRequest) =>
      Promise.resolve({ value: req.kind === "domain" ? req.value.split("@").pop()! : req.value, kind: req.kind ?? "address", createdAt: "2026-10-30T00:00:00.000Z" }),
    ),
    removeBlock: vi.fn().mockImplementation((value: string) => Promise.resolve({ value, blocked: false })),
    counts: vi.fn().mockRejectedValue(new Error("no counts")),
    ...over,
  };
}

function renderApp(api: MailApi): void {
  render(
    <MailApiProvider value={api}>
      <GmailApp />
    </MailApiProvider>,
  );
}

const rowSubjects = (): string[] =>
  screen.queryAllByTestId("fe2-mail-inbox-item").map((r) => r.textContent ?? "");
const inList = (subject: string): boolean => rowSubjects().some((t) => t.includes(subject));

async function openSpamAndBlock(kind: "address" | "domain" = "address"): Promise<void> {
  await waitFor(() => expect(inList("【限定】セール")).toBe(true));
  await userEvent.click(screen.getByText("【限定】セール"));
  await screen.findByTestId("fe2-mail-thread");
  await userEvent.click(screen.getByTestId("fe2-mail-more-trigger"));
  await userEvent.click(screen.getByTestId(kind === "domain" ? "fe2-mail-block-domain" : "fe2-mail-block-sender"));
  const dialog = await screen.findByTestId("fe2-mail-block-confirm");
  await userEvent.click(within(dialog).getByRole("button", { name: "ブロックする" }));
}

afterEach(() => localStorage.clear());

describe("mailModel block helpers", () => {
  const t = (from: string[], extra: Partial<MailThreadModel> = {}): MailThreadModel => ({
    id: "t",
    subject: "s",
    folder: "inbox",
    starred: false,
    labels: [],
    messages: from.map((email, i) => ({ id: `m${i}`, from: { email }, to: [], date: at(i), body: "", read: false })),
    ...extra,
  });

  it("matches addresses and (sub)domains case-insensitively", () => {
    const m = senderMatcher([
      { value: "a@x.example", kind: "address" },
      { value: "spam.example", kind: "domain" },
    ]);
    expect(m("A@X.example")).toBe(true);
    expect(m("b@x.example")).toBe(false);
    expect(m("q@mail.spam.example")).toBe(true);
  });

  it("a thread is blocked only when ALL received mail is from blocked senders", () => {
    const m = senderMatcher([{ value: "spam.example", kind: "domain" }]);
    expect(threadBlocked(t(["a@spam.example"]), m)).toBe(true);
    expect(threadBlocked(t(["a@spam.example", "friend@ok.example"]), m)).toBe(false);
    // Before the list loads, the server's per-message flag decides.
    const flagged = t(["a@spam.example"]);
    flagged.messages[0]!.blocked = true;
    expect(threadBlocked(flagged, null)).toBe(true);
  });

  it("blocked threads leave inbox/starred and show only under ブロック済み (Trash wins)", () => {
    const b = t(["a@spam.example"], { blocked: true, starred: true });
    expect(inFolder(b, "inbox")).toBe(false);
    expect(inFolder(b, "starred")).toBe(false);
    expect(inFolder(b, "blocked")).toBe(true);
    expect(inFolder({ ...b, folder: "trash" }, "blocked")).toBe(false);
    expect(inFolder({ ...b, folder: "trash" }, "trash")).toBe(true);
  });
});

describe("blocking a sender in the 3-pane mail app", () => {
  it("menu → confirm blocks the sender: gone from 受信トレイ, listed under ブロック済み, unread count drops", async () => {
    const api = fakeApi();
    renderApp(api);
    await waitFor(() => expect(screen.getByTestId("fe2-mail-gmail").getAttribute("data-unread")).toBe("3"));

    await openSpamAndBlock();
    expect(api.addBlock).toHaveBeenCalledWith({ value: "news@deals.example", kind: "address" });
    // The open conversation stays open with the banner (optimistic, before the POST settles).
    expect(await screen.findByTestId("fe2-mail-blocked-banner")).toHaveTextContent("news@deals.example");
    expect(screen.getByTestId("fe2-mail-gmail").getAttribute("data-unread")).toBe("2");
    expect(screen.getByTestId("fe2-mail-block-notice")).toHaveAttribute("data-status", "blocked");

    await userEvent.click(screen.getByTestId("fe2-mail-thread-back"));
    expect(inList("【限定】セール")).toBe(false);
    expect(inList("登壇のご相談")).toBe(true);

    await userEvent.click(screen.getByTestId("fe2-mail-folder-blocked"));
    expect(inList("【限定】セール")).toBe(true);
    expect(inList("登壇のご相談")).toBe(false);
    const rows = screen.getAllByTestId("fe2-mail-blocked-sender-row");
    expect(rows.map((r) => r.getAttribute("data-value"))).toEqual(["news@deals.example"]);
    // ブロック済み never shows an unread badge.
    expect(screen.getByTestId("fe2-mail-folder-blocked").textContent).toBe("ブロック済み");
  });

  it("unblocking from the management list restores the mail to 受信トレイ", async () => {
    const api = fakeApi({ listBlocks: vi.fn().mockResolvedValue([{ value: "news@deals.example", kind: "address", createdAt: "2026-10-01T00:00:00.000Z" }]) });
    renderApp(api);
    await waitFor(() => expect(inList("登壇のご相談")).toBe(true));
    await waitFor(() => expect(inList("【限定】セール")).toBe(false));

    await userEvent.click(screen.getByTestId("fe2-mail-folder-blocked"));
    await userEvent.click(within(screen.getByTestId("fe2-mail-blocked-sender-row")).getByTestId("fe2-mail-blocked-sender-unblock"));
    expect(api.removeBlock).toHaveBeenCalledWith("news@deals.example");
    expect(await screen.findByTestId("fe2-mail-blocked-senders-empty")).toBeInTheDocument();
    expect(inList("【限定】セール")).toBe(false);

    await userEvent.click(screen.getByTestId("fe2-mail-folder-inbox"));
    expect(inList("【限定】セール")).toBe(true);
  });

  it("the banner's ブロックを解除 puts the conversation back", async () => {
    const api = fakeApi({ listBlocks: vi.fn().mockResolvedValue([{ value: "deals.example", kind: "domain", createdAt: "2026-10-01T00:00:00.000Z" }]) });
    renderApp(api);
    await waitFor(() => expect(api.listBlocks).toHaveBeenCalled());
    await userEvent.click(screen.getByTestId("fe2-mail-folder-blocked"));
    await waitFor(() => expect(inList("【限定】セール")).toBe(true));
    await userEvent.click(screen.getByText("【限定】セール"));
    const banner = await screen.findByTestId("fe2-mail-blocked-banner");
    expect(banner).toHaveTextContent("ドメイン「deals.example」");
    await userEvent.click(within(banner).getByTestId("fe2-mail-blocked-banner-unblock"));
    expect(api.removeBlock).toHaveBeenCalledWith("deals.example");
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-blocked-banner")).toBeNull());
  });

  it("domain block sends kind=domain; the org domain cannot be blocked domain-wide", async () => {
    const api = fakeApi();
    renderApp(api);
    await openSpamAndBlock("domain");
    expect(api.addBlock).toHaveBeenCalledWith({ value: "deals.example", kind: "domain" });

    await userEvent.click(screen.getByTestId("fe2-mail-thread-back"));
    await userEvent.click(screen.getByText("会場下見"));
    await userEvent.click(await screen.findByTestId("fe2-mail-more-trigger"));
    expect(screen.getByTestId("fe2-mail-block-domain")).toBeDisabled();
    expect(screen.getByTestId("fe2-mail-block-sender")).not.toBeDisabled();
  });

  it("canceling the confirm changes nothing", async () => {
    const api = fakeApi();
    renderApp(api);
    await waitFor(() => expect(inList("【限定】セール")).toBe(true));
    await userEvent.click(screen.getByText("【限定】セール"));
    await userEvent.click(await screen.findByTestId("fe2-mail-more-trigger"));
    await userEvent.click(screen.getByTestId("fe2-mail-block-sender"));
    await userEvent.click(within(await screen.findByTestId("fe2-mail-block-confirm")).getByRole("button", { name: "キャンセル" }));
    expect(api.addBlock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("fe2-mail-blocked-banner")).toBeNull();
  });

  it("rolls back (mail returns to the inbox) and shows an error when the block fails", async () => {
    const api = fakeApi({ addBlock: vi.fn().mockRejectedValue(new Error("500")) });
    renderApp(api);
    await openSpamAndBlock();
    await waitFor(() => expect(screen.getByTestId("fe2-mail-block-notice")).toHaveAttribute("data-status", "failed"));
    expect(screen.getByTestId("fe2-mail-block-notice")).toHaveAttribute("role", "alert");
    expect(screen.queryByTestId("fe2-mail-blocked-banner")).toBeNull();
    await userEvent.click(screen.getByTestId("fe2-mail-thread-back"));
    expect(inList("【限定】セール")).toBe(true);
  });

  it("management list shows a skeleton while loading, then the empty state", async () => {
    let resolve: (v: mail.MailSenderBlock[]) => void = () => undefined;
    const api = fakeApi({ listBlocks: vi.fn().mockReturnValue(new Promise<mail.MailSenderBlock[]>((r) => (resolve = r))) });
    renderApp(api);
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-blocked"));
    expect(screen.getByTestId("fe2-mail-blocked-senders-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-mail-blocked-senders-empty")).toBeNull();
    resolve([]);
    expect(await screen.findByTestId("fe2-mail-blocked-senders-empty")).toBeInTheDocument();
  });

  it("uses the server's blocked flag before the block list loads (no flash in the inbox)", async () => {
    const flagged = INBOX.map((i) => (i.id === "spam" ? { ...i, blocked: true } : i));
    const api = fakeApi({
      listInbox: vi.fn().mockResolvedValue({ items: flagged, nextCursor: null }),
      listBlocks: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });
    renderApp(api);
    await waitFor(() => expect(inList("登壇のご相談")).toBe(true));
    expect(inList("【限定】セール")).toBe(false);
  });
});
