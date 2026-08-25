// Compose-attachment in-place preview (判断18 フォロー): clicking a draft's attachment chip
// opens a Modal that previews the file WITHOUT sending — image inline, pdf embedded, text
// panel, unsupported → fallback — with close and prev/next navigation. Drives the assembled
// GmailApp compose through a fake MailApi (same harness style as gmail.test.tsx).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
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
    ...over,
  };
}

const wrap = (ui: ReactNode, api: MailApi = fakeApi()): JSX.Element => <MailApiProvider value={api}>{ui}</MailApiProvider>;

async function openComposeWith(files: File[]): Promise<void> {
  await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
  await screen.findByTestId("fe2-mail-compose-window");
  await userEvent.upload(screen.getByTestId("fe2-mail-compose-attach-input"), files);
  await screen.findAllByTestId("fe2-mail-attach-chip");
}

async function openPreview(nth = 0): Promise<void> {
  const chips = await screen.findAllByTestId("fe2-mail-attach-chip");
  await userEvent.click(chips[nth]!);
  await screen.findByTestId("fe2-mail-attach-preview");
}

describe("compose attachment preview (Gmail-style, pre-send)", () => {
  it("previews an image inline", async () => {
    render(wrap(<GmailApp />));
    await openComposeWith([new File(["\x89PNG"], "shot.png", { type: "image/png" })]);
    await openPreview();
    expect(await screen.findByTestId("fe2-mail-preview-image")).toBeInTheDocument();
  });

  it("previews a text/code file as a text panel showing its content", async () => {
    render(wrap(<GmailApp />));
    await openComposeWith([new File(["hello preview body"], "notes.txt", { type: "text/plain" })]);
    await openPreview();
    await waitFor(() => expect(screen.getByTestId("fe2-mail-preview-text")).toHaveTextContent("hello preview body"));
  });

  it("previews a pdf in an embedded viewer", async () => {
    render(wrap(<GmailApp />));
    await openComposeWith([new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "doc.pdf", { type: "application/pdf" })]);
    await openPreview();
    expect(await screen.findByTestId("fe2-mail-preview-pdf")).toBeInTheDocument();
  });

  it("shows a download fallback for an unsupported type", async () => {
    render(wrap(<GmailApp />));
    await openComposeWith([new File([new Uint8Array([1, 2, 3])], "archive.zip", { type: "application/zip" })]);
    await openPreview();
    expect(await screen.findByTestId("fe2-mail-preview-unsupported")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-preview-download")).toBeInTheDocument();
  });

  it("closes the preview", async () => {
    render(wrap(<GmailApp />));
    await openComposeWith([new File(["x"], "a.txt", { type: "text/plain" })]);
    await openPreview();
    const dialog = screen.getByTestId("fe2-mail-attach-preview");
    await userEvent.click(within(dialog).getByRole("button", { name: "閉じる" }));
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-attach-preview")).not.toBeInTheDocument());
  });

  it("navigates between multiple attachments with prev/next", async () => {
    render(wrap(<GmailApp />));
    await openComposeWith([
      new File(["one"], "one.txt", { type: "text/plain" }),
      new File(["two"], "two.txt", { type: "text/plain" }),
    ]);
    await openPreview(0);
    expect(screen.getByTestId("fe2-mail-preview-counter")).toHaveTextContent("1 / 2");
    await userEvent.click(screen.getByTestId("fe2-mail-preview-next"));
    expect(screen.getByTestId("fe2-mail-preview-counter")).toHaveTextContent("2 / 2");
    // Wrap-around back to the first.
    await userEvent.click(screen.getByTestId("fe2-mail-preview-next"));
    expect(screen.getByTestId("fe2-mail-preview-counter")).toHaveTextContent("1 / 2");
  });

  it("clicking the remove (×) does not open the preview", async () => {
    render(wrap(<GmailApp />));
    await openComposeWith([new File(["x"], "a.txt", { type: "text/plain" })]);
    await userEvent.click(screen.getByTestId("fe2-mail-attach-remove"));
    expect(screen.queryByTestId("fe2-mail-attach-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-mail-attach-chip")).not.toBeInTheDocument();
  });
});
