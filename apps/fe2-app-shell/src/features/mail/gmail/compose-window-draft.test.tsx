// P1-2 follow-up regression: the floating ComposeWindow (the REAL "メール作成" surface
// reached from the launcher's メール tile → GmailApp), NOT the orphaned /mail/compose
// standalone route (ComposeScreen), must carry the same draft-autosave/leave-guard
// protection. This was missing entirely until now — reload/tab-close and in-app
// navigation both silently dropped an in-progress message with no warning, exactly
// the bug already fixed once for FE7's RoleEditorPage vs RolePermissionsEditor.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { COMPOSE_WINDOW_DRAFT_PREFIX } from "./ComposeWindow.tsx";

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

function wrap(ui: ReactNode, api: MailApi = fakeApi()): JSX.Element {
  return <MailApiProvider value={api}>{ui}</MailApiProvider>;
}

async function openCompose(): Promise<void> {
  await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
  await screen.findByTestId("fe2-mail-compose-window");
}

function draftKeys(): string[] {
  return Object.keys(localStorage).filter((k) => k.startsWith(COMPOSE_WINDOW_DRAFT_PREFIX));
}

describe("ComposeWindow (floating, the real メール作成 surface) — draft autosave", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("auto-saves subject/body to localStorage while dirty", async () => {
    const user = userEvent.setup();
    render(wrap(<GmailApp />));
    await openCompose();
    await user.type(screen.getByTestId("fe2-mail-compose-subject"), "書きかけの件名");
    await waitFor(() => expect(draftKeys().length).toBe(1));
    const raw = localStorage.getItem(draftKeys()[0]!);
    expect(raw).toContain("書きかけの件名");
  });

  it("does not persist a draft for an empty (pristine) compose window", async () => {
    render(wrap(<GmailApp />));
    await openCompose();
    await new Promise((r) => setTimeout(r, 50));
    expect(draftKeys().length).toBe(0);
  });

  it("restores a leftover draft into a re-opened window after an unmount (simulated reload)", async () => {
    const user = userEvent.setup();
    const { unmount } = render(wrap(<GmailApp />));
    await openCompose();
    await user.type(screen.getByTestId("fe2-mail-compose-subject"), "リロード前の件名");
    await waitFor(() => expect(draftKeys().length).toBe(1));

    unmount(); // the floating window's in-memory state (useMailStore) is gone, like a reload

    render(wrap(<GmailApp />));
    // GmailApp re-opens a window for the leftover draft on mount — no click needed.
    await screen.findByTestId("fe2-mail-compose-window");
    expect(screen.getByTestId("fe2-mail-compose-window-draft-notice")).toBeInTheDocument();
    expect((screen.getByTestId("fe2-mail-compose-subject") as HTMLInputElement).value).toBe("リロード前の件名");
  });

  it("discarding the restored draft clears storage and blanks the fields", async () => {
    const user = userEvent.setup();
    const { unmount } = render(wrap(<GmailApp />));
    await openCompose();
    await user.type(screen.getByTestId("fe2-mail-compose-subject"), "破棄されるはずの件名");
    await waitFor(() => expect(draftKeys().length).toBe(1));
    unmount();

    render(wrap(<GmailApp />));
    await screen.findByTestId("fe2-mail-compose-window-draft-notice");
    await user.click(screen.getByTestId("fe2-mail-compose-window-draft-notice-discard"));
    expect((screen.getByTestId("fe2-mail-compose-subject") as HTMLInputElement).value).toBe("");
    expect(draftKeys().length).toBe(0);
  });

  it("sending clears the draft (a later remount finds nothing to restore)", async () => {
    const user = userEvent.setup();
    const { unmount } = render(wrap(<GmailApp />));
    await openCompose();
    await user.type(screen.getByTestId("fe2-mail-compose-to"), "alice@example.com{enter}");
    await user.type(screen.getByTestId("fe2-mail-compose-subject"), "送信される件名");
    await waitFor(() => expect(draftKeys().length).toBe(1));

    await user.click(screen.getByTestId("fe2-mail-compose-send"));
    await waitFor(() => expect(draftKeys().length).toBe(0));

    unmount();
    render(wrap(<GmailApp />));
    expect(screen.queryByTestId("fe2-mail-compose-window")).not.toBeInTheDocument();
  });

  it("explicitly discarding via the header close (✕) clears the draft", async () => {
    const user = userEvent.setup();
    render(wrap(<GmailApp />));
    await openCompose();
    await user.type(screen.getByTestId("fe2-mail-compose-subject"), "閉じるボタンで破棄");
    await waitFor(() => expect(draftKeys().length).toBe(1));

    await user.click(screen.getByTestId("fe2-mail-compose-close"));
    await waitFor(() => expect(draftKeys().length).toBe(0));
  });
});
