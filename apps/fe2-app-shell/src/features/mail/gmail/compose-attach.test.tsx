// Gmail-parity attachment behaviour in the floating ComposeWindow: clip-pick, forbidden
// executable types refused with a visible error, oversize refused, normal files rendered as
// removable chips, and the picked file riding the SendMailRequest. Drives the assembled
// GmailApp through a fake MailApi (same harness style as gmail.test.tsx).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { MAX_ATTACHMENT_BYTES } from "../mailApi.tsx";
import { GmailApp } from "./GmailApp.tsx";

function fakeApi(over: Partial<MailApi> = {}): MailApi {
  return {
    send: vi.fn().mockResolvedValue({ messageId: "m", provider: "resend", acceptedAt: "t" }),
    listInbox: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getMessage: vi.fn(),
    getThread: vi.fn(),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    markUnread: vi.fn().mockResolvedValue({ read: false }),
    listSent: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSent: vi.fn(),
    downloadAttachment: vi.fn().mockResolvedValue(new Blob(["x"])),
    listFlags: vi.fn().mockResolvedValue([]),
    setFlags: vi.fn().mockResolvedValue({ threadId: "t", starred: false, archived: false, trashed: false }),
    ...over,
  };
}

function wrap(ui: ReactNode, api: MailApi = fakeApi()): JSX.Element {
  return <MailApiProvider value={api}>{ui}</MailApiProvider>;
}

// jsdom File whose size we can force (for the oversize path) while keeping a readable body.
function sizedFile(name: string, type: string, size: number, body = "data"): File {
  const f = new File([body], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

async function openCompose(): Promise<void> {
  await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
  await screen.findByTestId("fe2-mail-compose-window");
}

describe("ComposeWindow attachments (Gmail parity)", () => {
  it("accepts a normal file and shows a removable chip", async () => {
    render(wrap(<GmailApp />));
    await openCompose();
    const input = screen.getByTestId("fe2-mail-compose-attach-input");
    await userEvent.upload(input, new File(["hello world"], "note.txt", { type: "text/plain" }));
    const chip = await screen.findByTestId("fe2-mail-attach-chip");
    expect(chip).toHaveTextContent("note.txt");
    // Reads to ready (no error, no lingering progress that never resolves).
    await waitFor(() => expect(screen.getByTestId("fe2-mail-attach-chip")).toHaveAttribute("data-status", "ready"));
    // Remove it.
    await userEvent.click(screen.getByTestId("fe2-mail-attach-remove"));
    expect(screen.queryByTestId("fe2-mail-attach-chip")).not.toBeInTheDocument();
  });

  it("refuses a forbidden executable type with a visible error and no chip", async () => {
    render(wrap(<GmailApp />));
    await openCompose();
    const input = screen.getByTestId("fe2-mail-compose-attach-input");
    await userEvent.upload(input, new File(["MZ"], "malware.exe", { type: "application/octet-stream" }));
    expect(await screen.findByTestId("fe2-mail-attach-errors")).toHaveTextContent(/セキュリティ/);
    expect(screen.queryByTestId("fe2-mail-attach-chip")).not.toBeInTheDocument();
  });

  it("refuses a file over the per-file size ceiling", async () => {
    render(wrap(<GmailApp />));
    await openCompose();
    const input = screen.getByTestId("fe2-mail-compose-attach-input");
    await userEvent.upload(input, sizedFile("huge.bin", "application/octet-stream", MAX_ATTACHMENT_BYTES + 1));
    expect(await screen.findByTestId("fe2-mail-attach-errors")).toHaveTextContent(/大きすぎ/);
    expect(screen.queryByTestId("fe2-mail-attach-chip")).not.toBeInTheDocument();
  });

  it("sends the attachment on the SendMailRequest", async () => {
    const api = fakeApi();
    render(wrap(<GmailApp />, api));
    await openCompose();
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "dest@example.com");
    await userEvent.upload(screen.getByTestId("fe2-mail-compose-attach-input"), new File(["hello"], "note.txt", { type: "text/plain" }));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-attach-chip")).toHaveAttribute("data-status", "ready"));
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    expect(api.send).toHaveBeenCalledTimes(1);
    const req = (api.send as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(req.attachments).toHaveLength(1);
    expect(req.attachments[0].filename).toBe("note.txt");
    expect(typeof req.attachments[0].contentBase64).toBe("string");
  });

  it("supports drag-and-drop onto the compose window", async () => {
    render(wrap(<GmailApp />));
    await openCompose();
    const win = screen.getByTestId("fe2-mail-compose-window");
    const file = new File(["dropped"], "dropped.txt", { type: "text/plain" });
    // Simulate a files drag: dragOver shows the dropzone, drop ingests the file.
    const dt = { files: [file], types: ["Files"], dropEffect: "" } as unknown as DataTransfer;
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.dragEnter(win, { dataTransfer: dt });
    expect(screen.getByTestId("fe2-mail-compose-dropzone")).toBeInTheDocument();
    fireEvent.drop(win, { dataTransfer: dt });
    const chip = await screen.findByTestId("fe2-mail-attach-chip");
    expect(chip).toHaveTextContent("dropped.txt");
    // Dropzone overlay clears after drop.
    expect(screen.queryByTestId("fe2-mail-compose-dropzone")).not.toBeInTheDocument();
  });
});
