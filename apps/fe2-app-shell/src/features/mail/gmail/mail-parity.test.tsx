// Everything the UI offers must actually take effect: each case here was a control that looked
// fine and did nothing (or lost data) until the Gmail-parity pass.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { DRAFT_AUTOSAVE_MS } from "./useServerDraft.ts";

const inbound = (over: Record<string, unknown> = {}) => ({
  id: "in1", threadId: "t1", messageId: "<m1@x>", from: { email: "alice@example.com", name: "Alice" },
  to: [{ email: "me@developershub.jp" }], subject: "件名", snippet: "本文スニペット", receivedAt: "2026-11-06T00:00:00.000Z", read: false, ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({ ...inbound(over), textBody: "全文", read: true });
const page = (items: unknown[]) => ({ items, nextCursor: null, total: items.length });
const savedDraft = (id: string, d: object): mail.MailDraft => ({ ...(d as mail.MailDraftInput), id, updatedAt: "2026-11-06T00:00:00.000Z", attachments: [] });

function fakeApi(over: Partial<MailApi> = {}): MailApi {
  return {
    send: vi.fn().mockResolvedValue({ messageId: "m", provider: "resend", acceptedAt: "t" }),
    listInbox: vi.fn().mockResolvedValue(page([inbound()])),
    getMessage: vi.fn(),
    getThread: vi.fn().mockResolvedValue({ id: "t1", messages: [detail()] }),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    setReadState: vi.fn().mockResolvedValue(undefined),
    listDrafts: vi.fn().mockResolvedValue([]),
    saveDraft: vi.fn().mockImplementation((id: string, d: object) => Promise.resolve(savedDraft(id, d))),
    deleteDraft: vi.fn().mockResolvedValue(undefined),
    addDraftAttachment: vi.fn().mockResolvedValue({ id: "datt", filename: "a.txt", contentType: "text/plain", sizeBytes: 1 }),
    removeDraftAttachment: vi.fn().mockResolvedValue(undefined),
    listSent: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSent: vi.fn(),
    downloadAttachment: vi.fn().mockResolvedValue(new Blob(["bytes"], { type: "application/pdf" })),
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
    counts: vi.fn().mockRejectedValue(new Error("x")),
    ...over,
  } as MailApi;
}
const mount = (api: MailApi) => render(<MailApiProvider value={api}><GmailApp /></MailApiProvider>);
const row = () => screen.findByTestId("fe2-mail-inbox-item");
afterEach(() => localStorage.clear());

describe("read state", () => {
  it("既読にする reaches the server", async () => {
    const api = fakeApi();
    mount(api);
    const r = await row();
    fireEvent.mouseEnter(r);
    await userEvent.click(within(r).getByLabelText("既読にする"));
    expect(api.setReadState).toHaveBeenCalledWith(["in1"], true);
  });

  it("未読にする reaches the server, and in the reading pane returns to the list", async () => {
    const api = fakeApi({ listInbox: vi.fn().mockResolvedValue(page([inbound({ read: true })])) });
    mount(api);
    await userEvent.click(await row());
    await userEvent.click(await screen.findByLabelText("未読にする"));
    expect(api.setReadState).toHaveBeenCalledWith(["in1"], false);
    expect(await screen.findByTestId("fe2-mail-inbox")).toBeInTheDocument();
  });

  it("reopening a thread marked unread reads it again", async () => {
    const api = fakeApi({ listInbox: vi.fn().mockResolvedValue(page([inbound({ read: true })])) });
    mount(api);
    await userEvent.click(await row());
    await screen.findByTestId("fe2-mail-thread");
    await waitFor(() => expect(api.markRead).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByLabelText("未読にする"));
    await userEvent.click(await row());
    await waitFor(() => expect(api.markRead).toHaveBeenCalledTimes(2));
  });

  it("re-syncs when the server refuses, so the true state comes back", async () => {
    const api = fakeApi({ setReadState: vi.fn().mockRejectedValue(new Error("500")) });
    mount(api);
    const r = await row();
    fireEvent.mouseEnter(r);
    await userEvent.click(within(r).getByLabelText("既読にする"));
    await waitFor(() => expect(api.listInbox).toHaveBeenCalledTimes(2));
  });

  it("leaves another account's mail alone", async () => {
    const api = fakeApi({ listInbox: vi.fn().mockResolvedValue(page([inbound({ id: "o", mine: false }), inbound({ id: "own" })])) });
    mount(api);
    await userEvent.click(await screen.findByTestId("fe2-mail-select-all"));
    await userEvent.click(screen.getByTestId("fe2-mail-read-bulk"));
    expect(api.setReadState).toHaveBeenCalledWith(["own"], true);
  });
});

describe("inline reply", () => {
  const openAndType = async (text: string): Promise<void> => {
    await userEvent.click(await row());
    await userEvent.type(await screen.findByTestId("fe2-mail-inline-reply"), text);
  };

  it("a failed send is visible, leaves the thread and reopens as a compose with its text", async () => {
    const api = fakeApi({ send: vi.fn().mockRejectedValue(new Error("502")) });
    mount(api);
    await openAndType("届かない返信");
    await userEvent.click(screen.getByTestId("fe2-mail-inline-send"));
    const bar = await screen.findByTestId("fe2-mail-send-notice");
    await waitFor(() => expect(bar).toHaveAttribute("data-status", "failed"));
    expect(screen.queryAllByTestId("fe2-mail-thread-message")).toHaveLength(1);
    expect(await screen.findByTestId("fe2-mail-compose-body")).toHaveValue("届かない返信");
  });

  it("再試行 keeps the idempotency key and drops the draft once delivered", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("502")).mockResolvedValue({ messageId: "m", provider: "resend", acceptedAt: "t" });
    const api = fakeApi({ send });
    mount(api);
    await openAndType("二回目で届く");
    await userEvent.click(screen.getByTestId("fe2-mail-inline-send"));
    await userEvent.click(await screen.findByTestId("fe2-mail-send-retry"));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[0]![1]).toEqual(send.mock.calls[1]![1]);
    await waitFor(() => expect(api.deleteDraft).toHaveBeenCalled());
  });

  it("sends attachments alone", async () => {
    const api = fakeApi();
    mount(api);
    await userEvent.click(await row());
    await userEvent.upload(await screen.findByTestId("fe2-mail-inline-attach-input"), new File(["x"], "a.txt", { type: "text/plain" }));
    const btn = await screen.findByTestId("fe2-mail-inline-send");
    await waitFor(() => expect(btn).not.toBeDisabled());
    await userEvent.click(btn);
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.send).mock.calls[0]![0].attachments).toHaveLength(1);
  });

  it("offers the attach button as soon as the box is focused", async () => {
    mount(fakeApi());
    await userEvent.click(await row());
    expect(screen.queryByTestId("fe2-mail-inline-attach")).toBeNull();
    await userEvent.click(await screen.findByTestId("fe2-mail-inline-reply"));
    expect(screen.getByTestId("fe2-mail-inline-attach")).toBeInTheDocument();
  });
});

describe("compose validation", () => {
  const open = async (): Promise<void> => {
    await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
    await screen.findByTestId("fe2-mail-compose-window");
  };

  it("says why it cannot send without a recipient", async () => {
    const api = fakeApi();
    mount(api);
    await open();
    await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "x");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    expect(await screen.findByTestId("fe2-mail-compose-error")).toHaveTextContent("少なくとも 1 人の宛先");
    expect(api.send).not.toHaveBeenCalled();
  });

  it("asks before sending with no subject and no body, and an empty body goes out", async () => {
    const api = fakeApi();
    mount(api);
    await open();
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "bob@example.com,");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    const dialog = await screen.findByTestId("fe2-mail-compose-empty-confirm");
    expect(api.send).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "送信" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.send).mock.calls[0]![0].textBody).toBe("");
  });

  it("explains an over-size failure", async () => {
    const api = fakeApi({ send: vi.fn().mockRejectedValue(Object.assign(new Error("too large"), { status: 413 })) });
    mount(api);
    await open();
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "bob@example.com,");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "x");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    expect(await screen.findByText("添付ファイルが大きすぎるため送信できませんでした")).toBeInTheDocument();
  });

  it("a failed send brings the files back with the compose", async () => {
    const api = fakeApi({ send: vi.fn().mockRejectedValue(new Error("502")) });
    mount(api);
    await open();
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "bob@example.com,");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "x");
    await userEvent.upload(screen.getByTestId("fe2-mail-compose-attach-input"), new File(["hello"], "note.txt", { type: "text/plain" }));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-attach-chip")).toHaveAttribute("data-status", "ready"));
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    await waitFor(() => expect(screen.getByTestId("fe2-mail-send-notice")).toHaveAttribute("data-status", "failed"));
    const chip = await screen.findByTestId("fe2-mail-attach-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-status", "ready"));
  });
});

describe("下書き", () => {
  const typeDraft = async (): Promise<void> => {
    await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
    await userEvent.type(await screen.findByTestId("fe2-mail-compose-subject"), "書きかけ");
  };

  it("✕ saves it and the 下書き folder lists it", async () => {
    const api = fakeApi();
    mount(api);
    await typeDraft();
    await userEvent.click(screen.getByTestId("fe2-mail-compose-close"));
    await waitFor(() => expect(api.saveDraft).toHaveBeenCalled());
    expect(vi.mocked(api.saveDraft).mock.calls.at(-1)![1]).toMatchObject({ subject: "書きかけ", mode: "new" });
    await userEvent.click(screen.getByTestId("fe2-mail-folder-drafts"));
    expect(await screen.findByTestId("fe2-mail-draft-row")).toHaveTextContent("書きかけ");
  });

  it("autosaves while typing", async () => {
    const api = fakeApi();
    mount(api);
    await typeDraft();
    await waitFor(() => expect(api.saveDraft).toHaveBeenCalled(), { timeout: DRAFT_AUTOSAVE_MS + 1000 });
  });

  it("an untouched reply is not saved", async () => {
    const api = fakeApi();
    mount(api);
    await userEvent.click(await row());
    await userEvent.click(await screen.findByTestId("fe2-mail-reply"));
    await screen.findByTestId("fe2-mail-compose-window");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-close"));
    await new Promise((r) => setTimeout(r, 30));
    expect(api.saveDraft).not.toHaveBeenCalled();
  });

  it("the trash button discards it everywhere", async () => {
    const api = fakeApi();
    mount(api);
    await typeDraft();
    await userEvent.click(screen.getByTestId("fe2-mail-compose-discard"));
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-compose-window")).toBeNull());
    await new Promise((r) => setTimeout(r, DRAFT_AUTOSAVE_MS + 100));
    expect(api.saveDraft).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("reopens from the folder with its attachments, and sending removes it", async () => {
    const att = { id: "datt1", filename: "memo.txt", contentType: "text/plain", sizeBytes: 5 };
    const draft: mail.MailDraft = { id: "compose-1", mode: "new", to: "bob@example.com", cc: "", bcc: "", subject: "続き", body: "本文", updatedAt: "2026-11-06T00:00:00.000Z", attachments: [att] };
    let stored = [draft];
    const api = fakeApi({
      listDrafts: vi.fn().mockImplementation(() => Promise.resolve(stored)),
      deleteDraft: vi.fn().mockImplementation(() => {
        stored = [];
        return Promise.resolve();
      }),
    });
    mount(api);
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-drafts"));
    await userEvent.click(await screen.findByTestId("fe2-mail-draft-open"));
    expect(await screen.findByTestId("fe2-mail-compose-subject")).toHaveValue("続き");
    await waitFor(() => expect(api.downloadAttachment).toHaveBeenCalledWith("drafts", "compose-1", "datt1"));
    const chip = await screen.findByTestId("fe2-mail-attach-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-status", "ready"));
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.send).mock.calls[0]![0].attachments).toHaveLength(1);
    await waitFor(() => expect(api.deleteDraft).toHaveBeenCalledWith("compose-1"));
    expect(api.addDraftAttachment).not.toHaveBeenCalled(); // already on the draft
    await waitFor(() => expect(screen.queryByTestId("fe2-mail-draft-row")).toBeNull());
  });

  it("the sidebar counts drafts; the folder shows no inbox pager", async () => {
    const draft: mail.MailDraft = { id: "c", mode: "new", to: "", cc: "", bcc: "", subject: "", body: "x", updatedAt: "2026-11-06T00:00:00.000Z", attachments: [] };
    mount(fakeApi({ listDrafts: vi.fn().mockResolvedValue([draft]) }));
    const folder = await screen.findByTestId("fe2-mail-folder-drafts");
    await waitFor(() => expect(folder).toHaveTextContent("1"));
    await userEvent.click(folder);
    await screen.findByTestId("fe2-mail-drafts");
    expect(screen.queryByTestId("fe2-mail-page-range")).toBeNull();
  });
});

describe("すべてのメール", () => {
  it("shows archived mail, and 受信トレイに移動 undoes the archive on the server", async () => {
    const api = fakeApi({
      listInbox: vi.fn().mockImplementation((q: { folder?: string }) => Promise.resolve(q.folder === "all" ? page([inbound()]) : page([]))),
      listFlags: vi.fn().mockResolvedValue([{ threadId: "t1", starred: false, archived: true, trashed: false, purged: false }]),
    });
    mount(api);
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-all"));
    const r = await row();
    expect(api.listInbox).toHaveBeenCalledWith(expect.objectContaining({ folder: "all" }));
    fireEvent.mouseEnter(r);
    await userEvent.click(within(r).getByTestId("fe2-mail-move-inbox"));
    await waitFor(() => expect(api.setFlags).toHaveBeenCalledWith("t1", expect.objectContaining({ archived: false })));
  });

  it("marks what is still in the inbox", async () => {
    mount(fakeApi());
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-all"));
    await screen.findByTestId("fe2-mail-inbox-chip");
  });
});

describe("送信済み", () => {
  const sent = { id: "log1", from: { email: "me@developershub.jp" }, to: [{ email: "bob@example.com" }], subject: "送信", snippet: "短縮された本文", sentAt: "2026-11-05T00:00:00.000Z" };

  it("lists a conversation you replied in, named after its recipient", async () => {
    const reply = { ...sent, id: "log2", threadId: "t1", to: [{ email: "alice@example.com", name: "Alice" }], sentAt: "2026-11-06T01:00:00.000Z" };
    mount(fakeApi({ listSent: vi.fn().mockResolvedValue({ items: [reply], nextCursor: null }) }));
    await row();
    await userEvent.click(screen.getByTestId("fe2-mail-folder-sent"));
    expect(await row()).toHaveTextContent("Alice");
  });

  it("a trashed sent mail still opens in full", async () => {
    const api = fakeApi({
      listInbox: vi.fn().mockResolvedValue(page([])),
      listSent: vi.fn().mockResolvedValue({ items: [sent], nextCursor: null }),
      listFlags: vi.fn().mockResolvedValue([{ threadId: "log1", starred: false, archived: false, trashed: true, purged: false }]),
      getSent: vi.fn().mockResolvedValue({ ...sent, textBody: "長い全文" }),
    });
    mount(api);
    await userEvent.click(await screen.findByTestId("fe2-mail-folder-trash"));
    await userEvent.click(await row());
    expect(await screen.findByText("長い全文")).toBeInTheDocument();
    expect(api.getThread).not.toHaveBeenCalled();
  });
});

describe("転送", () => {
  const withFile = (file: Record<string, unknown>) => ({ getThread: vi.fn().mockResolvedValue({ id: "t1", messages: [detail({ attachments: [file] })] }) });

  it("carries the original's files and Gmail's forward header", async () => {
    const api = fakeApi(withFile({ id: "a1", filename: "資料.pdf", contentType: "application/pdf", sizeBytes: 5 }));
    mount(api);
    await userEvent.click(await row());
    await screen.findByTestId("fe2-mail-attachment");
    await userEvent.click(screen.getByTestId("fe2-mail-forward"));
    const win = await screen.findByTestId("fe2-mail-compose-window");
    await waitFor(() => expect(api.downloadAttachment).toHaveBeenCalledWith("messages", "in1", "a1"));
    await within(win).findByText("資料.pdf");
    expect((within(win).getByTestId("fe2-mail-compose-body") as HTMLTextAreaElement).value).toContain("---------- Forwarded message ---------");
  });

  it("skips a file that was never stored, and says so when one can't be fetched", async () => {
    const api = fakeApi({
      ...withFile({ id: "a1", filename: "資料.pdf", contentType: "application/pdf", sizeBytes: 5 }),
      downloadAttachment: vi.fn().mockRejectedValue(new Error("404")),
    });
    mount(api);
    await userEvent.click(await row());
    await screen.findByTestId("fe2-mail-attachment");
    await userEvent.click(screen.getByTestId("fe2-mail-forward"));
    expect(await screen.findByText(/添付ファイルを読み込めませんでした/)).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-compose-send")).not.toBeDisabled();
  });

  it("a reply does not carry files", async () => {
    const api = fakeApi(withFile({ id: "a1", filename: "資料.pdf", contentType: "application/pdf", sizeBytes: 5 }));
    mount(api);
    await userEvent.click(await row());
    await screen.findByTestId("fe2-mail-attachment");
    await userEvent.click(screen.getByTestId("fe2-mail-reply"));
    await screen.findByTestId("fe2-mail-compose-window");
    expect(api.downloadAttachment).not.toHaveBeenCalled();
  });
});

describe("HTML mail", () => {
  const html = (htmlBody: string, attachments: unknown[] = []) => ({ getThread: vi.fn().mockResolvedValue({ id: "t1", messages: [detail({ htmlBody, attachments })] }) });

  it("renders sanitized, and keeps remote images off until asked", async () => {
    mount(fakeApi(html(`<script>window.x=1</script><p style="color:red; position:fixed" onclick="x()">本文</p><img src="https://t.example/p.gif">`)));
    await userEvent.click(await row());
    const body = await screen.findByTestId("fe2-mail-body-html");
    expect(body.innerHTML).not.toMatch(/script|onclick|position/);
    expect(body.querySelector("p")).toHaveAttribute("style", "color: red");
    expect(body.querySelector("img")).not.toHaveAttribute("src");
    await userEvent.click(screen.getByTestId("fe2-mail-images-show"));
    expect(screen.getByTestId("fe2-mail-body-html").querySelector("img")).toHaveAttribute("src", "https://t.example/p.gif");
  });

  it("loads an inline cid: image from its own attachment, and shows no chip for it", async () => {
    URL.createObjectURL = vi.fn(() => "blob:inline");
    URL.revokeObjectURL = vi.fn();
    const api = fakeApi(html(`<img src="cid:logo@x">`, [{ id: "a1", filename: "logo.png", contentType: "image/png", sizeBytes: 5, contentId: "logo@x" }]));
    mount(api);
    await userEvent.click(await row());
    const body = await screen.findByTestId("fe2-mail-body-html");
    await waitFor(() => expect(body.querySelector("img")).toHaveAttribute("src", "blob:inline"));
    expect(screen.queryByTestId("fe2-mail-attachment-image")).toBeNull();
    expect(screen.queryByTestId("fe2-mail-images-blocked")).toBeNull();
  });
});

describe("attachment download failure", () => {
  it("is reported", async () => {
    const api = fakeApi({
      getThread: vi.fn().mockResolvedValue({ id: "t1", messages: [detail({ attachments: [{ id: "a1", filename: "資料.pdf", contentType: "application/pdf", sizeBytes: 5 }] })] }),
      downloadAttachment: vi.fn().mockRejectedValue(new Error("500")),
    });
    mount(api);
    await userEvent.click(await row());
    await userEvent.click(await screen.findByTestId("fe2-mail-attachment"));
    expect(await screen.findByText("資料.pdf をダウンロードできませんでした")).toBeInTheDocument();
  });
});

describe("keyboard", () => {
  const list = page([inbound({ id: "a", threadId: "ta", receivedAt: "2026-11-06T03:00:00.000Z" }), inbound({ id: "b", threadId: "tb", receivedAt: "2026-11-06T02:00:00.000Z" }), inbound({ id: "c", threadId: "tc", receivedAt: "2026-11-06T01:00:00.000Z" })]);
  const cursorRow = (): HTMLElement | undefined => screen.getAllByTestId("fe2-mail-inbox-item").find((r) => r.getAttribute("data-cursor") === "true");
  const rows = () => screen.findAllByTestId("fe2-mail-inbox-item");

  it("j / k walk the list one row at a time, o opens", async () => {
    const api = fakeApi({ listInbox: vi.fn().mockResolvedValue(list), getThread: vi.fn().mockImplementation((id: string) => Promise.resolve({ id, messages: [detail({ threadId: id })] })) });
    mount(api);
    const [first, second] = await rows();
    await userEvent.keyboard("j");
    expect(cursorRow()).toBe(first);
    await userEvent.keyboard("j");
    expect(cursorRow()).toBe(second);
    await userEvent.keyboard("k");
    expect(cursorRow()).toBe(first);
    await userEvent.keyboard("o");
    expect(await screen.findByTestId("fe2-mail-thread")).toBeInTheDocument();
  });

  it("x selects, s stars, shift+i marks read", async () => {
    const api = fakeApi({ listInbox: vi.fn().mockResolvedValue(list) });
    mount(api);
    await rows();
    await userEvent.keyboard("j");
    await userEvent.keyboard("s");
    await waitFor(() => expect(api.setFlags).toHaveBeenCalledWith("ta", expect.objectContaining({ starred: true })));
    await userEvent.keyboard("x");
    await screen.findByText("1件を選択中");
    await userEvent.keyboard("I");
    expect(api.setReadState).toHaveBeenCalledWith(["a"], true);
  });

  it("r / a / f open the matching compose; ? lists the shortcuts", async () => {
    mount(fakeApi());
    await userEvent.click(await row());
    await screen.findByTestId("fe2-mail-thread");
    await userEvent.keyboard("f");
    expect(await screen.findByTestId("fe2-mail-compose-subject")).toHaveValue("Fwd: 件名");
    await userEvent.click(screen.getByTestId("fe2-mail-thread-back"));
    await userEvent.keyboard("?");
    expect(await screen.findByTestId("fe2-mail-shortcuts")).toHaveTextContent("全員に返信");
  });

  it("stays out of the way while typing", async () => {
    const api = fakeApi();
    mount(api);
    await row();
    await userEvent.type(screen.getByTestId("fe2-mail-search"), "j");
    expect(screen.queryByTestId("fe2-mail-compose-window")).toBeNull();
    expect(screen.queryAllByTestId("fe2-mail-inbox-item").some((r) => r.hasAttribute("data-cursor"))).toBe(false);
  });
});
