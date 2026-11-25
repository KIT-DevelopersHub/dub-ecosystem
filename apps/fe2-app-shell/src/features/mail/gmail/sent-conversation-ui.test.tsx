// 送信済み → 会話 (Gmail): opening a send that got answered shows the whole conversation,
// replies included, even when the replies are not on the loaded inbox page.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";

const ME = { email: "alice@developershub.jp", name: "Alice" };
const CLIENT = { email: "client@outside.com", name: "Client" };
const BOSS = { email: "boss@outside.com", name: "Boss" };
const CONV = "maillog_ROOT@developershub.jp";
const sent: mail.MailSentListItem = {
  id: "maillog_ROOT",
  from: ME,
  to: [CLIENT],
  subject: "見積もりの件",
  snippet: "送った本文",
  sentAt: "2026-11-01T00:00:00.000Z",
  provider: "resend",
  status: "sent",
  conversation: { id: CONV, messageCount: 3, latestAt: "2026-11-03T00:00:00.000Z", repliedBy: [CLIENT, BOSS] },
};
const received = (id: string, from: mail.MailAddress, at: string, textBody: string): mail.MailMessageDetail => ({
  id,
  messageId: `${id}@outside.com`,
  threadId: CONV,
  from,
  to: [ME],
  subject: "Re: 見積もりの件",
  snippet: textBody,
  receivedAt: at,
  read: false,
  textBody,
});

function fakeApi(over: Partial<MailApi> = {}): MailApi {
  return {
    send: vi.fn(),
    listInbox: vi.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }),
    getMessage: vi.fn(),
    getThread: vi.fn().mockResolvedValue({
      id: CONV,
      messages: [received("r1", CLIENT, "2026-11-02T00:00:00.000Z", "一通目の返信です"), received("r2", BOSS, "2026-11-03T00:00:00.000Z", "二通目の返信です")],
    }),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    setReadState: vi.fn().mockResolvedValue(undefined),
    bulkAction: vi.fn().mockResolvedValue(undefined),
    listDrafts: vi.fn().mockResolvedValue([]),
    saveDraft: vi.fn(),
    deleteDraft: vi.fn().mockResolvedValue(undefined),
    addDraftAttachment: vi.fn(),
    removeDraftAttachment: vi.fn(),
    listSent: vi.fn().mockResolvedValue({ items: [sent], nextCursor: null }),
    getSent: vi.fn().mockResolvedValue({ ...sent, textBody: "送った本文の全文" }),
    downloadAttachment: vi.fn(),
    listFlags: vi.fn().mockResolvedValue([]),
    setFlags: vi.fn().mockResolvedValue({}),
    schedule: vi.fn(),
    listScheduled: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getScheduled: vi.fn(),
    updateScheduled: vi.fn(),
    cancelScheduled: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue([]),
    addBlock: vi.fn(),
    removeBlock: vi.fn(),
    getForward: vi.fn(),
    registerForward: vi.fn(),
    updateForward: vi.fn(),
    removeForward: vi.fn(),
    avatars: vi.fn().mockResolvedValue({ avatars: {} }),
    counts: vi.fn().mockRejectedValue(new Error("no counts")),
    ...over,
  } as MailApi;
}

afterEach(() => localStorage.clear());

describe("送信済み → 会話", () => {
  it("lists an answered send as 自分, <replier> with the conversation size, and opens every message", async () => {
    const api = fakeApi();
    render(
      <MailApiProvider value={api}>
        <GmailApp />
      </MailApiProvider>,
    );
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-sent"));
    const row = await screen.findByTestId("fe2-mail-inbox-item");
    expect(row).toHaveTextContent("自分, Boss");
    expect(row).toHaveTextContent("3");

    await userEvent.click(row);
    // The replies come from GET /threads/:conversation, our own send from GET /sent/:id.
    expect(await screen.findByText("二通目の返信です")).toBeInTheDocument();
    expect(api.getThread).toHaveBeenCalledWith(CONV);
    expect(api.getSent).toHaveBeenCalledWith("maillog_ROOT");
    // Newly fetched replies are marked read on the server.
    await waitFor(() => expect(api.markRead).toHaveBeenCalledWith("r2"));
  });

  it("a send nobody answered still opens on its own (no thread fetch)", async () => {
    const lone = { ...sent };
    delete lone.conversation;
    const api = fakeApi({ listSent: vi.fn().mockResolvedValue({ items: [lone], nextCursor: null }) });
    render(
      <MailApiProvider value={api}>
        <GmailApp />
      </MailApiProvider>,
    );
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-sent"));
    const row = await screen.findByTestId("fe2-mail-inbox-item");
    expect(row).toHaveTextContent("Client");
    await userEvent.click(row);
    expect(await screen.findByText("送った本文の全文")).toBeInTheDocument();
    expect(api.getThread).not.toHaveBeenCalled();
  });
});
