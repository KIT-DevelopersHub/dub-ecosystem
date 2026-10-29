// Send failure is visible (送信できませんでした + 再試行), the compose is restored, and the
// optimistic Sent entry is dropped. Bcc is sent as an envelope-only recipient list.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { initialMailState, reducer, type ComposeState, type PendingSend } from "./useMailStore.tsx";

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
    listBlocks: vi.fn().mockResolvedValue([]),
    addBlock: vi.fn().mockImplementation((req: { value: string; kind?: "address" | "domain" }) => Promise.resolve({ value: req.value.toLowerCase(), kind: req.kind ?? "address", createdAt: "2026-01-01T00:00:00.000Z" })),
    removeBlock: vi.fn().mockImplementation((value: string) => Promise.resolve({ value, blocked: false })),
    ...over,
  };
}

afterEach(() => localStorage.clear());

async function composeAndSend(): Promise<void> {
  await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
  await screen.findByTestId("fe2-mail-compose-window");
  await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "bob@example.com,");
  await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "件名A");
  await userEvent.type(screen.getByTestId("fe2-mail-compose-body"), "消えてほしくない本文");
  await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
}

describe("send failure", () => {
  it("shows 送信できませんでした, restores the compose, and 再試行 sends it", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("502"))
      .mockResolvedValueOnce({ messageId: "m", provider: "resend", acceptedAt: "t" });
    render(
      <MailApiProvider value={fakeApi({ send })}>
        <GmailApp />
      </MailApiProvider>,
    );
    await composeAndSend();

    const bar = await screen.findByTestId("fe2-mail-send-notice");
    await waitFor(() => expect(bar).toHaveAttribute("data-status", "failed"));
    expect(within(bar).getByText("送信できませんでした")).toBeInTheDocument();
    // Draft restored, not lost.
    const win = await screen.findByTestId("fe2-mail-compose-window");
    expect(within(win).getByTestId("fe2-mail-compose-body")).toHaveValue("消えてほしくない本文");
    expect(within(win).getByTestId("fe2-mail-compose-subject")).toHaveValue("件名A");

    await userEvent.click(within(bar).getByTestId("fe2-mail-send-retry"));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-send-notice")).toHaveAttribute("data-status", "sent"));
    expect(screen.getByText("送信しました")).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toMatchObject({ to: [{ email: "bob@example.com" }], subject: "件名A", textBody: "消えてほしくない本文" });
    expect(screen.queryByTestId("fe2-mail-compose-window")).toBeNull();
  });

  it("shows 送信しました on success and closes the compose", async () => {
    render(
      <MailApiProvider value={fakeApi()}>
        <GmailApp />
      </MailApiProvider>,
    );
    await composeAndSend();
    await waitFor(() => expect(screen.getByTestId("fe2-mail-send-notice")).toHaveAttribute("data-status", "sent"));
    expect(screen.queryByTestId("fe2-mail-compose-window")).toBeNull();
  });

  it("SEND_FAILED drops the optimistic Sent entry and reopens the compose", () => {
    const compose: ComposeState = {
      id: "c1", mode: "new", to: "bob@example.com", cc: "", bcc: "", subject: "s", body: "b",
      showCc: false, showBcc: false, minimized: false, maximized: false,
    };
    const pending: PendingSend = { kind: "send", req: { to: [{ email: "bob@example.com" }], subject: "s", textBody: "b" }, compose, threadId: "t-opt" };
    let s = reducer(initialMailState, { type: "SEND", to: [{ email: "bob@example.com" }], cc: [], subject: "s", body: "b", threadId: "t-opt" });
    expect(s.threads.map((t) => t.id)).toContain("t-opt");
    s = reducer(s, { type: "SEND_FAILED", pending });
    expect(s.threads.map((t) => t.id)).not.toContain("t-opt");
    expect(s.composes).toEqual([compose]);
    expect(s.sendNotice?.status).toBe("failed");
  });
});

describe("Bcc", () => {
  it("opens the Bcc field and includes bcc in the send payload", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "m", provider: "resend", acceptedAt: "t" });
    render(
      <MailApiProvider value={fakeApi({ send })}>
        <GmailApp />
      </MailApiProvider>,
    );
    await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
    const toggle = await screen.findByTestId("fe2-mail-compose-bcc-toggle");
    expect(toggle).toBeEnabled();
    expect(screen.queryByTestId("fe2-mail-compose-bcc")).toBeNull();
    await userEvent.click(toggle);
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "bob@example.com,");
    await userEvent.type(await screen.findByTestId("fe2-mail-compose-bcc"), "secret@example.com,");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "件名B");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0]).toMatchObject({
      to: [{ email: "bob@example.com" }],
      bcc: [{ email: "secret@example.com" }],
      subject: "件名B",
    });
    expect(send.mock.calls[0]![0].cc).toBeUndefined();
  });

  it("omits bcc from the payload when the field is empty", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "m", provider: "resend", acceptedAt: "t" });
    render(
      <MailApiProvider value={fakeApi({ send })}>
        <GmailApp />
      </MailApiProvider>,
    );
    await composeAndSend();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].bcc).toBeUndefined();
  });

  it("restores the Bcc recipients when the send fails", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("502"));
    render(
      <MailApiProvider value={fakeApi({ send })}>
        <GmailApp />
      </MailApiProvider>,
    );
    await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
    await userEvent.click(await screen.findByTestId("fe2-mail-compose-bcc-toggle"));
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "bob@example.com,");
    await userEvent.type(await screen.findByTestId("fe2-mail-compose-bcc"), "secret@example.com,");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    const bar = await screen.findByTestId("fe2-mail-send-notice");
    await waitFor(() => expect(bar).toHaveAttribute("data-status", "failed"));
    const win = await screen.findByTestId("fe2-mail-compose-window");
    expect(within(win).getByTestId("fe2-mail-compose-bcc-field")).toHaveTextContent("secret@example.com");
  });
});
