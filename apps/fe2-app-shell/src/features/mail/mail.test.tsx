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
    const api: MailApi = { send, listInbox: vi.fn() };
    render(wrap(<ComposeScreen />, api));
    await userEvent.click(screen.getByTestId("fe2-mail-compose-send"));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText("宛先を1件以上入力してください。")).toBeInTheDocument();
  });

  it("sends a valid SendMailRequest and clears the form", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "m1", provider: "ses", acceptedAt: "t" });
    const api: MailApi = { send, listInbox: vi.fn() };
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

describe("InboxScreen", () => {
  it("renders the empty state when there are no messages", async () => {
    const api: MailApi = { send: vi.fn(), listInbox: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) };
    render(wrap(<InboxScreen />, api));
    expect(await screen.findByTestId("fe2-mail-inbox-empty")).toBeInTheDocument();
  });

  it("renders received messages", async () => {
    const items: mail.MailMessage[] = [
      {
        id: "1",
        messageId: "<1@x>",
        threadId: "t1",
        from: { email: "sender@x.com", name: "Sender" },
        to: [{ email: "me@x.com" }],
        subject: "Welcome",
        snippet: "hello",
        receivedAt: "2026-08-10T00:00:00.000Z",
      },
    ];
    const page: common.Paginated<mail.MailMessage> = { items, nextCursor: null };
    const api: MailApi = { send: vi.fn(), listInbox: vi.fn().mockResolvedValue(page) };
    render(wrap(<InboxScreen />, api));
    expect(await screen.findByText("Welcome")).toBeInTheDocument();
    expect(screen.getByText("Sender <sender@x.com>")).toBeInTheDocument();
  });
});
