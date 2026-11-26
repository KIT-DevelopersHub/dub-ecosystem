// 共用アドレスから送る (0027): the 差出人 picker in the floating compose window — shown only when the
// user may send as a shared address, the signature swap, and fromAddress on the request.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { swapSignature } from "./sendAs.ts";

const INFO = "info@developershub.jp";
const SIG = "--\n北陸ITカンファレンス 実行委員会\ninfo@developershub.jp";
const OPTIONS: mail.MailSendAsOption[] = [
  { address: "me@developershub.jp", kind: "self" },
  { address: INFO, kind: "shared", displayName: "北陸ITカンファレンス 実行委員会", signature: SIG },
];

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
    getScheduled: vi.fn().mockResolvedValue({ id: "sch", to: [], subject: "s", snippet: "", scheduledAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", status: "scheduled", textBody: "b" }),
    updateScheduled: vi.fn().mockResolvedValue({ id: "sch", to: [], subject: "s", snippet: "", scheduledAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", status: "scheduled", textBody: "b" }),
    cancelScheduled: vi.fn().mockResolvedValue({ id: "sch", status: "canceled" }),
    setReadState: vi.fn().mockResolvedValue(undefined),
    bulkAction: vi.fn().mockResolvedValue(undefined),
    listDrafts: vi.fn().mockResolvedValue([]),
    saveDraft: vi.fn().mockImplementation((id: string, d: object) => Promise.resolve({ ...d, id, updatedAt: "2026-01-01T00:00:00.000Z", attachments: [] })),
    deleteDraft: vi.fn().mockResolvedValue(undefined),
    addDraftAttachment: vi.fn().mockResolvedValue({ id: "datt", filename: "f", contentType: "text/plain", sizeBytes: 1 }),
    removeDraftAttachment: vi.fn().mockResolvedValue(undefined),
    listTemplates: vi.fn().mockResolvedValue([]),
    saveTemplate: vi.fn().mockImplementation((id: string, t: object) => Promise.resolve({ ...t, id, updatedAt: "2026-01-01T00:00:00.000Z" })),
    deleteTemplate: vi.fn().mockResolvedValue(undefined),
    listBlocks: vi.fn().mockResolvedValue([]),
    addBlock: vi.fn().mockImplementation((req: { value: string; kind?: "address" | "domain" }) => Promise.resolve({ value: req.value.toLowerCase(), kind: req.kind ?? "address", createdAt: "2026-01-01T00:00:00.000Z" })),
    getForward: vi.fn().mockResolvedValue({ target: null, status: "none", enabled: false, active: false, available: true, requestedAt: null, verifiedAt: null, lastResult: null, lastError: null, lastAt: null }),
    registerForward: vi.fn(),
    updateForward: vi.fn(),
    removeForward: vi.fn(),
    avatars: vi.fn().mockResolvedValue({ avatars: {} }),
    removeBlock: vi.fn().mockImplementation((value: string) => Promise.resolve({ value, blocked: false })),
    counts: vi.fn().mockRejectedValue(new Error("no counts")),
    ...over,
  };
}


function wrap(ui: ReactNode, api: MailApi): JSX.Element {
  return <MailApiProvider value={api}>{ui}</MailApiProvider>;
}

async function openCompose(): Promise<void> {
  await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
  await screen.findByTestId("fe2-mail-compose-window");
}

const body = () => (screen.getByTestId("fe2-mail-compose-body") as HTMLTextAreaElement).value;

describe("swapSignature", () => {
  it("adds once at the end of a new mail and takes it back out", () => {
    const withSig = swapSignature("よろしくお願いします。\n", false, undefined, SIG);
    expect(withSig).toBe(`よろしくお願いします。\n\n${SIG}`);
    expect(swapSignature(withSig, false, undefined, SIG)).toBe(withSig);
    expect(swapSignature(withSig, false, SIG, undefined)).toBe("よろしくお願いします。");
  });

  it("goes above the forwarded text, and an edited signature is left alone", () => {
    const fwd = "\n\n---------- Forwarded message ---------\nFrom: a";
    expect(swapSignature(fwd, true, undefined, SIG)).toBe(`\n\n${SIG}${fwd}`);
    expect(swapSignature(`\n\n${SIG}${fwd}`, true, SIG, undefined)).toBe(fwd);
    expect(swapSignature("手で直した署名", false, SIG, undefined)).toBe("手で直した署名");
  });
});

describe("差出人 in compose", () => {
  it("is hidden when there is no shared address to pick", async () => {
    const api = fakeApi({ listSendAs: vi.fn().mockResolvedValue([OPTIONS[0]!]) });
    render(wrap(<GmailApp />, api));
    await openCompose();
    await screen.findByTestId("fe2-mail-compose-subject");
    expect(screen.queryByTestId("fe2-mail-compose-from")).not.toBeInTheDocument();
  });

  it("defaults to the user's own address and sends no fromAddress", async () => {
    const api = fakeApi({ listSendAs: vi.fn().mockResolvedValue(OPTIONS) });
    render(wrap(<GmailApp />, api));
    await openCompose();
    const select = (await screen.findByTestId("fe2-mail-compose-from")) as HTMLSelectElement;
    expect(select.value).toBe("me@developershub.jp");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "speaker@example.com");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "ご依頼");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    const req = (api.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as mail.SendMailRequest;
    expect(req.fromAddress).toBeUndefined();
  });

  it("picking info@ adds its signature and sends fromAddress; switching back removes it", async () => {
    const api = fakeApi({ listSendAs: vi.fn().mockResolvedValue(OPTIONS) });
    render(wrap(<GmailApp />, api));
    await openCompose();
    const select = await screen.findByTestId("fe2-mail-compose-from");
    expect(select).toHaveTextContent("北陸ITカンファレンス 実行委員会 <info@developershub.jp>");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-body"), "ご検討ください。");
    await userEvent.selectOptions(select, INFO);
    expect(body()).toBe(`ご検討ください。\n\n${SIG}`);
    await userEvent.selectOptions(select, "me@developershub.jp");
    expect(body()).toBe("ご検討ください。");
    await userEvent.selectOptions(select, INFO);
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "speaker@example.com");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "基調講演のご依頼");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    const req = (api.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as mail.SendMailRequest;
    expect(req.fromAddress).toBe(INFO);
    expect(req.textBody).toBe(`ご検討ください。\n\n${SIG}`);
  });

  it("a scheduled send carries the picked From too", async () => {
    const api = fakeApi({ listSendAs: vi.fn().mockResolvedValue(OPTIONS) });
    render(wrap(<GmailApp />, api));
    await openCompose();
    await userEvent.selectOptions(await screen.findByTestId("fe2-mail-compose-from"), INFO);
    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "speaker@example.com,");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "基調講演のご依頼");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-schedule-open"));
    const input = await screen.findByTestId("fe2-mail-compose-schedule-input");
    await userEvent.clear(input);
    const d = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    await userEvent.type(input, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`);
    await userEvent.click(screen.getByTestId("fe2-mail-compose-schedule-confirm"));
    await waitFor(() => expect(api.schedule).toHaveBeenCalledTimes(1));
    const req = (api.schedule as ReturnType<typeof vi.fn>).mock.calls[0]![0] as mail.ScheduleMailRequest;
    expect(req.fromAddress).toBe(INFO);
  });
});
