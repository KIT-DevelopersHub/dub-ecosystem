// 予約送信 for REPLIES and with ATTACHMENTS (gateway migration 0020): the inline reply and
// the 返信 floating composer both offer the schedule picker, a scheduled reply carries its
// In-Reply-To + Cc/Bcc, and files attached to a compose/reply ride the schedule request.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { DEMO_INBOX_ITEMS, DEMO_INBOX_THREAD, DEMO_SENT_DETAIL, DEMO_SENT_ITEMS } from "./mailModel.fixtures.ts";

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
    getScheduled: vi.fn(),
    updateScheduled: vi.fn(),
    cancelScheduled: vi.fn().mockResolvedValue({ id: "sch", status: "canceled" }),
    ...over,
  };
}

const FUTURE = "2099-01-01T09:00";
const png = (): File => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "photo.png", { type: "image/png" });
const scheduledReq = (api: MailApi): mail.ScheduleMailRequest =>
  (api.schedule as ReturnType<typeof vi.fn>).mock.calls[0]![0] as mail.ScheduleMailRequest;

async function pickAndConfirm(prefix: string): Promise<void> {
  await waitFor(() => expect(screen.getByTestId(`${prefix}-open`)).not.toBeDisabled());
  await userEvent.click(screen.getByTestId(`${prefix}-open`));
  const input = await screen.findByTestId(`${prefix}-input`);
  await userEvent.clear(input);
  await userEvent.type(input, FUTURE);
  await userEvent.click(screen.getByTestId(`${prefix}-confirm`));
}

async function openThread(api: MailApi): Promise<void> {
  render(<MailApiProvider value={api}><GmailApp /></MailApiProvider>);
  await userEvent.click((await screen.findAllByTestId("fe2-mail-inbox-item"))[0]!);
  await waitFor(() => expect(screen.getByText(/相談させてください/)).toBeInTheDocument());
}

describe("inline reply — 予約送信", () => {
  it("shows the schedule option and schedules the reply with In-Reply-To, Cc/Bcc and an image", async () => {
    const api = fakeApi();
    await openThread(api);
    await userEvent.type(screen.getByTestId("fe2-mail-inline-reply"), "あとで送る返信です");
    expect(screen.getByTestId("fe2-mail-inline-schedule-open")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("fe2-mail-inline-ccbcc-toggle"));
    await userEvent.type(screen.getByTestId("fe2-mail-inline-cc"), "cc@example.com,");
    await userEvent.type(screen.getByTestId("fe2-mail-inline-bcc"), "secret@example.com,");
    await userEvent.upload(screen.getByTestId("fe2-mail-inline-attach-input"), png());
    expect(within(screen.getByTestId("fe2-mail-inline-attach-tray")).getByText("photo.png")).toBeInTheDocument();

    await pickAndConfirm("fe2-mail-inline-schedule");
    await waitFor(() => expect(api.schedule).toHaveBeenCalledTimes(1));
    const req = scheduledReq(api);
    expect(req.inReplyTo).toBe("<in1@developershub.jp>");
    expect(req.subject).toMatch(/^Re: /);
    expect(req.to).toEqual([{ email: "hanako@example.com", name: "山田 花子" }]);
    expect(req.cc).toEqual([{ email: "cc@example.com" }]);
    expect(req.bcc).toEqual([{ email: "secret@example.com" }]);
    expect(req.textBody).toBe("あとで送る返信です");
    expect(Date.parse(req.scheduledAt)).toBeGreaterThan(Date.now());
    expect(req.attachments).toHaveLength(1);
    expect(req.attachments![0]).toMatchObject({ filename: "photo.png", contentType: "image/png" });
    expect(req.attachments![0]!.contentBase64.length).toBeGreaterThan(0);

    // Not sent now, not appended to the thread; the box is reset.
    expect(api.send).not.toHaveBeenCalled();
    expect(screen.getByTestId("fe2-mail-inline-reply")).toHaveValue("");
    expect(screen.queryByTestId("fe2-mail-inline-attach-tray")).toBeNull();
  });

  it("shows a pending scheduled reply under its thread", async () => {
    const parked: mail.ScheduledSendListItem = {
      id: "sch_r",
      to: [{ email: "hanako@example.com" }],
      subject: "Re: 登壇のご相談",
      snippet: "x",
      scheduledAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "scheduled",
      inReplyTo: "<in1@developershub.jp>",
      attachments: [{ id: "a1", filename: "photo.png", contentType: "image/png", sizeBytes: 4 }],
    };
    await openThread(fakeApi({ listScheduled: vi.fn().mockResolvedValue({ items: [parked], nextCursor: null }) }));
    const chip = await screen.findByTestId("fe2-mail-thread-scheduled-item");
    expect(chip).toHaveTextContent("返信を送信予定");
  });

  it("rejects a past time without calling schedule", async () => {
    const api = fakeApi();
    await openThread(api);
    await userEvent.type(screen.getByTestId("fe2-mail-inline-reply"), "返信");
    await userEvent.click(screen.getByTestId("fe2-mail-inline-schedule-open"));
    const input = await screen.findByTestId("fe2-mail-inline-schedule-input");
    await userEvent.clear(input);
    await userEvent.type(input, "2000-01-01T09:00");
    await userEvent.click(screen.getByTestId("fe2-mail-inline-schedule-confirm"));
    expect(api.schedule).not.toHaveBeenCalled();
    expect(screen.getByTestId("fe2-mail-inline-schedule-popover")).toHaveTextContent("未来の日時");
  });
});

describe("返信 floating composer — 予約送信", () => {
  it("schedules a reply from the 返信 composer with its In-Reply-To", async () => {
    const api = fakeApi();
    await openThread(api);
    await userEvent.click(screen.getByTestId("fe2-mail-reply"));
    await screen.findByTestId("fe2-mail-compose-window");
    expect(screen.getByTestId("fe2-mail-compose-schedule-open")).toBeInTheDocument();
    await pickAndConfirm("fe2-mail-compose-schedule");
    await waitFor(() => expect(api.schedule).toHaveBeenCalledTimes(1));
    expect(scheduledReq(api).inReplyTo).toBe("<in1@developershub.jp>");
  });
});

describe("new compose — 予約送信 with attachments + Bcc", () => {
  it("allows attachments and Bcc when scheduling (no longer rejected)", async () => {
    const api = fakeApi();
    render(<MailApiProvider value={api}><GmailApp /></MailApiProvider>);
    await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
    await screen.findByTestId("fe2-mail-compose-window");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "recipient@example.com,");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-bcc-toggle"));
    await userEvent.type(screen.getByTestId("fe2-mail-compose-bcc"), "hidden@example.com,");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "資料送付（予約）");
    await userEvent.upload(screen.getByTestId("fe2-mail-compose-attach-input"), new File(["hello"], "note.txt", { type: "text/plain" }));

    await waitFor(() => expect(screen.getByTestId("fe2-mail-compose-schedule-open")).not.toBeDisabled());
    await userEvent.click(screen.getByTestId("fe2-mail-compose-schedule-open"));
    expect(screen.getByTestId("fe2-mail-compose-schedule-popover")).toHaveTextContent("添付ファイル 1 件も一緒に予約されます");
    const input = screen.getByTestId("fe2-mail-compose-schedule-input");
    await userEvent.clear(input);
    await userEvent.type(input, FUTURE);
    await userEvent.click(screen.getByTestId("fe2-mail-compose-schedule-confirm"));

    await waitFor(() => expect(api.schedule).toHaveBeenCalledTimes(1));
    const req = scheduledReq(api);
    expect(req.bcc).toEqual([{ email: "hidden@example.com" }]);
    expect(req.attachments).toEqual([{ filename: "note.txt", contentType: "text/plain", contentBase64: btoa("hello") }]);
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-compose-window")).toBeNull());
  });
});

describe("予約済み folder — reply / attachment rows", () => {
  it("marks a scheduled reply and its attachment count; editing it asks first", async () => {
    const parked: mail.ScheduledSendListItem = {
      id: "sch_a",
      to: [{ email: "recipient@example.com" }],
      subject: "Re: 添付つき",
      snippet: "x",
      scheduledAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "scheduled",
      inReplyTo: "<in1@developershub.jp>",
      attachments: [{ id: "a1", filename: "photo.png", contentType: "image/png", sizeBytes: 4 }],
    };
    const api = fakeApi({ listScheduled: vi.fn().mockResolvedValue({ items: [parked], nextCursor: null }) });
    render(<MailApiProvider value={api}><GmailApp /></MailApiProvider>);
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-scheduled"));
    const row = await screen.findByTestId("fe2-mail-scheduled-row");
    expect(within(row).getByTestId("fe2-mail-scheduled-reply-badge")).toHaveTextContent("返信");
    expect(within(row).getByTestId("fe2-mail-scheduled-attach")).toHaveTextContent("1");
    await userEvent.click(within(row).getByTestId("fe2-mail-scheduled-edit"));
    expect(await screen.findByText(/添付ファイルは作成画面でもう一度添付してください/)).toBeInTheDocument();
    expect(api.getScheduled).not.toHaveBeenCalled();
  });
});

describe("delivered reply with attachments in its conversation", () => {
  it("shows the folded reply's files (fetched from its Sent detail)", async () => {
    const item: mail.MailSentListItem = {
      id: "sent_sched_reply",
      from: { email: "info@developershub.jp" },
      to: [{ email: "hanako@example.com", name: "山田 花子" }],
      subject: "Re: 登壇のご相談",
      snippet: "予約した返信",
      sentAt: "2099-08-10T02:00:00.000Z",
      provider: "resend",
      status: "sent",
      threadId: "thr_in_1",
    };
    const detail = {
      ...item,
      textBody: "予約した返信",
      attachments: [{ id: "att_1", filename: "agenda.txt", contentType: "text/plain", sizeBytes: 5 }],
    } as mail.MailSentDetail;
    const getSent = vi.fn().mockResolvedValue(detail);
    await openThread(
      fakeApi({
        listInbox: vi.fn().mockResolvedValue({ items: [DEMO_INBOX_ITEMS[0]!], nextCursor: null }),
        listSent: vi.fn().mockResolvedValue({ items: [item], nextCursor: null }),
        getSent,
      }),
    );
    await waitFor(() => expect(getSent).toHaveBeenCalledWith("sent_sched_reply"));
    expect(await screen.findByText("agenda.txt")).toBeInTheDocument();
  });
});
