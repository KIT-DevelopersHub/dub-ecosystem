// 送信 must post ONE mail even when clicked twice (the prod thread showed the same reply
// twice), each send carries an idempotency key, and a reply whose newest message is our own
// sent reply re-addresses the original correspondent (never ourselves).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { DEMO_INBOX_ITEMS, DEMO_INBOX_THREAD, DEMO_SENT_DETAIL } from "./mailModel.fixtures.ts";

function fakeApi(over: Partial<MailApi> = {}): MailApi {
  return {
    // Never resolves during the test: the double click lands while the first send is in flight.
    send: vi.fn().mockImplementation(() => new Promise(() => undefined)),
    listInbox: vi.fn().mockResolvedValue({ items: [DEMO_INBOX_ITEMS[0]!], nextCursor: null }),
    getMessage: vi.fn(),
    getThread: vi.fn().mockResolvedValue(DEMO_INBOX_THREAD),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    listSent: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSent: vi.fn().mockResolvedValue(DEMO_SENT_DETAIL),
    downloadAttachment: vi.fn().mockResolvedValue(new Blob(["x"])),
    listFlags: vi.fn().mockResolvedValue([]),
    setFlags: vi.fn().mockImplementation((threadId: string) => Promise.resolve({ threadId, starred: false, archived: false, trashed: false, purged: false })),
    schedule: vi.fn(),
    listScheduled: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getScheduled: vi.fn(),
    updateScheduled: vi.fn(),
    cancelScheduled: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue([]),
    addBlock: vi.fn(),
    removeBlock: vi.fn(),
    counts: vi.fn().mockRejectedValue(new Error("no counts")),
    ...over,
  };
}

const sendCalls = (api: MailApi) => (api.send as ReturnType<typeof vi.fn>).mock.calls as Array<[mail.SendMailRequest, { idempotencyKey?: string } | undefined]>;

async function openThread(api: MailApi): Promise<void> {
  render(<MailApiProvider value={api}><GmailApp /></MailApiProvider>);
  await userEvent.click((await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!);
  await waitFor(() => expect(screen.getByText(/相談させてください/)).toBeInTheDocument());
}

describe("double submit", () => {
  it("inline reply: double-clicking 送信 sends once, with an idempotency key", async () => {
    const api = fakeApi();
    await openThread(api);
    await userEvent.type(screen.getByTestId("fe2-mail-inline-reply"), "え、大丈夫？");
    await userEvent.dblClick(screen.getByTestId("fe2-mail-inline-send"));
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(sendCalls(api)[0]![1]?.idempotencyKey).toMatch(/.{8,}/);
  });

  it("compose window: double-clicking 送信 sends once, with an idempotency key", async () => {
    const api = fakeApi();
    await openThread(api);
    await userEvent.click(screen.getByTestId("fe2-mail-reply"));
    await userEvent.dblClick(await screen.findByTestId("fe2-mail-compose-send"));
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(sendCalls(api)[0]![1]?.idempotencyKey).toMatch(/.{8,}/);
  });
});

describe("reply after our own reply", () => {
  it("re-addresses the original correspondent and threads against our sent message", async () => {
    // Our earlier reply (newest message) folded into the conversation.
    const ours: mail.MailSentListItem = {
      id: "maillog_ours",
      from: { email: "info@developershub.jp" },
      to: [{ email: "hanako@example.com", name: "山田 花子" }],
      cc: [{ email: "yuki@example.com" }],
      subject: "Re: 登壇のご相談",
      snippet: "先ほどの件です",
      sentAt: "2099-08-10T02:00:00.000Z",
      provider: "resend",
      status: "sent",
      threadId: DEMO_INBOX_ITEMS[0]!.threadId,
    };
    const api = fakeApi({
      listSent: vi.fn().mockResolvedValue({ items: [ours], nextCursor: null }),
      getSent: vi.fn().mockResolvedValue({ ...ours, textBody: "先ほどの件です" }),
    });
    await openThread(api);
    await waitFor(() => expect(screen.getByText(/宛先: 山田 花子$/)).toBeInTheDocument());
    // 全員に返信 keeps the original Cc in Cc (and never adds ourselves).
    await userEvent.click(screen.getByTestId("fe2-mail-reply-all"));
    await screen.findByTestId("fe2-mail-compose-cc");
    const win = screen.getByTestId("fe2-mail-compose-window");
    expect(win).toHaveTextContent("yuki@example.com");
    expect(win.textContent).toMatch(/To山田 花子Bcc/); // To = the correspondent only, not info@ (us)
    await userEvent.type(screen.getByTestId("fe2-mail-inline-reply"), "追記です");
    await userEvent.click(screen.getByTestId("fe2-mail-inline-send"));
    const [req] = sendCalls(api)[0]!;
    expect(req.to).toEqual([{ email: "hanako@example.com", name: "山田 花子" }]);
    expect(req.inReplyTo).toBe("maillog_ours@developershub.jp");
  });
});
