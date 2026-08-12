// Mail feature tests: the api adapter maps onto the shell ApiClient.request, the
// recipient parser is correct, and the compose/inbox screens drive the MailApi
// (validation gate, send-on-submit, empty vs list rendering). All run against a
// faked MailApi / ApiClient — no real network, green without a live backend.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { common, mail } from "@dub/types";
import type { ApiClient, RequestInput } from "../../lib/api-client.tsx";
import { createMailApi, isValidEmail, parseRecipients, type MailApi } from "./mailApi.tsx";
import { MailApiProvider } from "./MailProvider.tsx";
import { ComposeScreen } from "./ComposeScreen.tsx";
import { InboxScreen } from "./InboxScreen.tsx";
import { SentScreen } from "./SentScreen.tsx";
import { ThreadDetail } from "./MessageDetail.tsx";

// MailFolderTabs (rendered by Inbox/Sent screens) uses the shell router's useNavigate;
// screens are unit-tested in isolation (no RouterProvider), so stub it to a no-op.
const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateSpy }));

function fakeApi(result: unknown = undefined): { api: ApiClient; calls: RequestInput[] } {
  const calls: RequestInput[] = [];
  const request = vi.fn(<TRes,>(input: RequestInput): Promise<TRes> => {
    calls.push(input);
    return Promise.resolve(result as TRes);
  });
  return { api: { request } as unknown as ApiClient, calls };
}

function wrap(ui: ReactNode, api: MailApi): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MailApiProvider value={api}>{ui}</MailApiProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe("createMailApi", () => {
  it("send POSTs the user-facing /api/v1/mail/outbox with the SendMailRequest", async () => {
    const { api, calls } = fakeApi({ messageId: "m1", provider: "ses", acceptedAt: "t" });
    const req: mail.SendMailRequest = { to: [{ email: "a@x.com" }], subject: "Hi", textBody: "Body" };
    const res = await createMailApi(api).send(req);
    expect(res).toMatchObject({ messageId: "m1" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/mail/outbox", body: req });
  });

  it("listInbox GETs /api/v1/mail/messages and forwards the limit", async () => {
    const { api, calls } = fakeApi({ items: [], nextCursor: null });
    await createMailApi(api).listInbox({ limit: 50 });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/mail/messages", query: { limit: 50 } });
  });

  it("listInbox omits the query object entirely when no params are given", async () => {
    const { api, calls } = fakeApi({ items: [], nextCursor: null });
    await createMailApi(api).listInbox();
    expect(calls[0]!.query).toBeUndefined();
  });

  it("getMessage GETs /api/v1/mail/messages/:id", async () => {
    const { api, calls } = fakeApi({ id: "m1", textBody: "b", read: false });
    await createMailApi(api).getMessage("m1");
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/mail/messages/m1" });
  });

  it("getThread GETs /api/v1/mail/threads/:id", async () => {
    const { api, calls } = fakeApi({ id: "t1", messages: [] });
    await createMailApi(api).getThread("t1");
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/mail/threads/t1" });
  });

  it("markRead POSTs /api/v1/mail/messages/:id/read", async () => {
    const { api, calls } = fakeApi({ read: true });
    const res = await createMailApi(api).markRead("m1");
    expect(res).toEqual({ read: true });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/mail/messages/m1/read" });
  });

  it("listSent GETs /api/v1/mail/sent and forwards the limit", async () => {
    const { api, calls } = fakeApi({ items: [], nextCursor: null });
    await createMailApi(api).listSent({ limit: 50 });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/mail/sent", query: { limit: 50 } });
  });

  it("listSent omits the query object entirely when no params are given", async () => {
    const { api, calls } = fakeApi({ items: [], nextCursor: null });
    await createMailApi(api).listSent();
    expect(calls[0]!.query).toBeUndefined();
  });

  it("getSent GETs /api/v1/mail/sent/:id", async () => {
    const { api, calls } = fakeApi({ id: "s1", textBody: "b", status: "sent" });
    await createMailApi(api).getSent("s1");
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/mail/sent/s1" });
  });
});

describe("parseRecipients / isValidEmail", () => {
  it("splits on comma / semicolon / newline and parses named addresses", () => {
    const { recipients, invalid } = parseRecipients("a@x.com, Bob <bob@y.com>\nc@z.com");
    expect(recipients).toEqual([{ email: "a@x.com" }, { email: "bob@y.com", name: "Bob" }, { email: "c@z.com" }]);
    expect(invalid).toEqual([]);
  });

  it("collects malformed tokens as invalid", () => {
    const { recipients, invalid } = parseRecipients("good@x.com, not-an-email");
    expect(recipients).toEqual([{ email: "good@x.com" }]);
    expect(invalid).toEqual(["not-an-email"]);
  });

  it("isValidEmail rejects blanks and missing parts", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});

describe("ComposeScreen", () => {
  it("blocks submit and shows errors when fields are empty (no send call)", async () => {
    const send = vi.fn();
    const api: MailApi = fullApi({ send });
    render(wrap(<ComposeScreen />, api));
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText("宛先を1件以上入力してください。")).toBeInTheDocument();
  });

  it("sends a valid SendMailRequest and clears the form", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "m1", provider: "ses", acceptedAt: "t" });
    const api: MailApi = fullApi({ send });
    render(wrap(<ComposeScreen />, api));

    await userEvent.type(screen.getByTestId("fe2-mail-compose-to"), "alice@example.com");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-subject"), "Subject");
    await userEvent.type(screen.getByTestId("fe2-mail-compose-body"), "Hello there");
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({ to: [{ email: "alice@example.com" }], subject: "Subject", textBody: "Hello there" });
    await waitFor(() => expect((screen.getByTestId("fe2-mail-compose-subject") as HTMLInputElement).value).toBe(""));
  });
});

function listItem(over: Partial<mail.MailMessageListItem> = {}): mail.MailMessageListItem {
  return {
    id: "1",
    messageId: "<1@x>",
    threadId: "t1",
    from: { email: "sender@x.com", name: "Sender" },
    to: [{ email: "me@x.com" }],
    subject: "Welcome",
    snippet: "hello",
    receivedAt: "2026-08-10T00:00:00.000Z",
    read: false,
    ...over,
  };
}
function detail(over: Partial<mail.MailMessageDetail> = {}): mail.MailMessageDetail {
  return { ...listItem(), textBody: "Body text", ...over };
}
function fullApi(over: Partial<MailApi> = {}): MailApi {
  return {
    send: vi.fn(),
    listInbox: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getMessage: vi.fn(),
    getThread: vi.fn(),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    listSent: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSent: vi.fn(),
    downloadAttachment: vi.fn().mockResolvedValue(new Blob(["x"])),
    ...over,
  };
}

function sentListItem(over: Partial<mail.MailSentListItem> = {}): mail.MailSentListItem {
  return {
    id: "s1",
    to: [{ email: "bob@x.com", name: "Bob" }],
    subject: "Report",
    snippet: "Here is the report.",
    sentAt: "2026-08-11T00:00:00.000Z",
    provider: "resend",
    status: "sent",
    ...over,
  };
}
function sentDetail(over: Partial<mail.MailSentDetail> = {}): mail.MailSentDetail {
  return { ...sentListItem(), textBody: "Here is the report body.", ...over };
}

describe("InboxScreen", () => {
  it("renders the empty state when there are no messages", async () => {
    const api = fullApi();
    render(wrap(<InboxScreen />, api));
    expect(await screen.findByTestId("fe2-mail-inbox-empty")).toBeInTheDocument();
  });

  it("renders received messages with an unread badge for unread items", async () => {
    const page: common.Paginated<mail.MailMessageListItem> = { items: [listItem()], nextCursor: null };
    const api = fullApi({ listInbox: vi.fn().mockResolvedValue(page) });
    render(wrap(<InboxScreen />, api));
    expect(await screen.findByText("Welcome")).toBeInTheDocument();
    expect(screen.getByText("Sender <sender@x.com>")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-inbox-unread")).toBeInTheDocument();
  });

  it("omits the unread badge for already-read items", async () => {
    const page: common.Paginated<mail.MailMessageListItem> = { items: [listItem({ read: true })], nextCursor: null };
    const api = fullApi({ listInbox: vi.fn().mockResolvedValue(page) });
    render(wrap(<InboxScreen />, api));
    await screen.findByText("Welcome");
    expect(screen.queryByTestId("fe2-mail-inbox-unread")).not.toBeInTheDocument();
  });

  it("opens the thread detail and marks the message read on click", async () => {
    const page: common.Paginated<mail.MailMessageListItem> = { items: [listItem()], nextCursor: null };
    const getThread = vi.fn().mockResolvedValue({ id: "t1", messages: [detail({ textBody: "Full body here" })] });
    const markRead = vi.fn().mockResolvedValue({ read: true });
    const api = fullApi({ listInbox: vi.fn().mockResolvedValue(page), getThread, markRead });
    render(wrap(<InboxScreen />, api));

    await userEvent.click(await screen.findByTestId("fe2-mail-inbox-item"));

    expect(markRead).toHaveBeenCalledWith("1");
    expect(getThread).toHaveBeenCalledWith("t1");
    expect(await screen.findByTestId("fe2-mail-thread")).toBeInTheDocument();
    expect(screen.getByText("Full body here")).toBeInTheDocument();
  });

  it("does not mark an already-read message on open", async () => {
    const page: common.Paginated<mail.MailMessageListItem> = { items: [listItem({ read: true })], nextCursor: null };
    const markRead = vi.fn();
    const api = fullApi({
      listInbox: vi.fn().mockResolvedValue(page),
      getThread: vi.fn().mockResolvedValue({ id: "t1", messages: [detail({ read: true })] }),
      markRead,
    });
    render(wrap(<InboxScreen />, api));
    await userEvent.click(await screen.findByTestId("fe2-mail-inbox-item"));
    expect(markRead).not.toHaveBeenCalled();
  });
});

describe("SentScreen", () => {
  it("renders the empty state when nothing has been sent", async () => {
    const api = fullApi();
    render(wrap(<SentScreen />, api));
    expect(await screen.findByTestId("fe2-mail-sent-empty")).toBeInTheDocument();
  });

  it("renders sent messages with recipients and a folder switch", async () => {
    const page: common.Paginated<mail.MailSentListItem> = { items: [sentListItem()], nextCursor: null };
    const api = fullApi({ listSent: vi.fn().mockResolvedValue(page) });
    render(wrap(<SentScreen />, api));
    expect(await screen.findByText("Report")).toBeInTheDocument();
    expect(screen.getByText("宛先: Bob <bob@x.com>")).toBeInTheDocument();
    // Inbox / Sent folder tabs are present, Sent active.
    expect(screen.getByTestId("fe2-mail-folders")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-mail-folders-tab-sent")).toHaveAttribute("aria-selected", "true");
  });

  it("opens the sent detail with the full body on click", async () => {
    const page: common.Paginated<mail.MailSentListItem> = { items: [sentListItem()], nextCursor: null };
    const getSent = vi.fn().mockResolvedValue(sentDetail({ textBody: "Full sent body." }));
    const api = fullApi({ listSent: vi.fn().mockResolvedValue(page), getSent });
    render(wrap(<SentScreen />, api));

    await userEvent.click(await screen.findByTestId("fe2-mail-sent-item"));
    expect(getSent).toHaveBeenCalledWith("s1");
    expect(await screen.findByTestId("fe2-mail-sent-detail")).toBeInTheDocument();
    expect(screen.getByText("Full sent body.")).toBeInTheDocument();
  });
});

describe("MailFolderTabs (via InboxScreen)", () => {
  it("navigates to /mail/sent when the Sent tab is clicked", async () => {
    navigateSpy.mockClear();
    render(wrap(<InboxScreen />, fullApi()));
    await screen.findByTestId("fe2-mail-inbox-empty");
    await userEvent.click(screen.getByTestId("fe2-mail-folders-tab-sent"));
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/mail/sent" });
  });
});

describe("ThreadDetail", () => {
  it("renders the plain-text body and a back button", async () => {
    const getThread = vi.fn().mockResolvedValue({ id: "t1", messages: [detail({ textBody: "Dear team" })] });
    const api = fullApi({ getThread });
    const onBack = vi.fn();
    render(wrap(<ThreadDetail threadId="t1" onBack={onBack} />, api));
    expect(await screen.findByTestId("fe2-mail-body-text")).toHaveTextContent("Dear team");
    await userEvent.click(screen.getByTestId("fe2-mail-thread-back"));
    expect(onBack).toHaveBeenCalled();
  });

  it("renders an HTML-only body sanitized (script stripped)", async () => {
    const messages = [detail({ textBody: "", htmlBody: '<p>hi<script>alert(1)</script></p>' })];
    const api = fullApi({ getThread: vi.fn().mockResolvedValue({ id: "t1", messages }) });
    render(wrap(<ThreadDetail threadId="t1" onBack={vi.fn()} />, api));
    const el = await screen.findByTestId("fe2-mail-body-html");
    expect(el.innerHTML).toContain("hi");
    expect(el.innerHTML).not.toContain("script");
  });
});
