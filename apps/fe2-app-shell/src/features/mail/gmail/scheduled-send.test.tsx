// 予約送信 (scheduled send) UX in the assembled GmailApp: the compose window's clock
// action schedules a future send via MailApi.schedule, and the 予約済み folder lists parked
// sends with a working 取消 (cancel). Same fake-MailApi harness as the other gmail tests.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";

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
    getScheduled: vi.fn(),
    updateScheduled: vi.fn(),
    cancelScheduled: vi.fn().mockResolvedValue({ id: "sch", status: "canceled" }),
    ...over,
  };
}

function wrap(ui: ReactNode, api: MailApi): JSX.Element {
  return <MailApiProvider value={api}>{ui}</MailApiProvider>;
}

const futureLocal = "2099-01-01T09:00";

describe("ComposeWindow — scheduled send (予約送信)", () => {
  it("schedules a future send via MailApi.schedule and closes the window", async () => {
    const api = fakeApi();
    render(wrap(<GmailApp />, api));
    await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
    await screen.findByTestId("fe2-mail-compose-window");

    // Fill To + subject/body.
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "recipient@example.com,");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "予約テスト");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-body"), "あとで送る本文");

    // Open the schedule popover, pick a future time, confirm.
    await userEvent.click(screen.getByTestId("fe2-mail-compose-schedule-open"));
    const input = await screen.findByTestId("fe2-mail-compose-schedule-input");
    await userEvent.clear(input);
    await userEvent.type(input, futureLocal);
    await userEvent.click(screen.getByTestId("fe2-mail-compose-schedule-confirm"));

    await waitFor(() => expect(api.schedule).toHaveBeenCalledTimes(1));
    const req = (api.schedule as unknown as { mock: { calls: [mail.ScheduleMailRequest][] } }).mock.calls[0]![0];
    expect(req.subject).toBe("予約テスト");
    expect(req.to[0]!.email).toBe("recipient@example.com");
    expect(Date.parse(req.scheduledAt)).toBeGreaterThan(Date.now());
    // Window closed after scheduling.
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-compose-window")).toBeNull());
  });

  it("rejects a past time (does not call schedule)", async () => {
    const api = fakeApi();
    render(wrap(<GmailApp />, api));
    await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "recipient@example.com,");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-schedule-open"));
    const input = await screen.findByTestId("fe2-mail-compose-schedule-input");
    await userEvent.clear(input);
    await userEvent.type(input, "2000-01-01T09:00");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-schedule-confirm"));
    expect(api.schedule).not.toHaveBeenCalled();
    expect(screen.getByTestId("fe2-mail-compose-schedule-popover")).toHaveTextContent("未来の日時");
  });
});

describe("予約済み folder", () => {
  const parked: mail.ScheduledSendListItem = {
    id: "sch_1",
    to: [{ email: "recipient@example.com" }],
    subject: "予約中のメール",
    snippet: "本文プレビュー",
    scheduledAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "scheduled",
  };

  it("lists parked sends and cancels one via MailApi.cancelScheduled", async () => {
    const api = fakeApi({ listScheduled: vi.fn().mockResolvedValueOnce({ items: [parked], nextCursor: null }).mockResolvedValue({ items: [], nextCursor: null }) });
    render(wrap(<GmailApp />, api));
    // Navigate to the 予約済み folder.
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-scheduled"));
    const row = await screen.findByTestId("fe2-mail-scheduled-row");
    expect(row).toHaveTextContent("予約中のメール");

    await userEvent.click(within(row).getByTestId("fe2-mail-scheduled-cancel"));
    await waitFor(() => expect(api.cancelScheduled).toHaveBeenCalledWith("sch_1"));
    // Optimistically removed from the list.
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-scheduled-row")).toBeNull());
  });
});
