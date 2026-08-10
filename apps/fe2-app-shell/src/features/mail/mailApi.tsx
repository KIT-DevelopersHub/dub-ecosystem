// Mail feature api adapter (design 2-4). Like FE3–FE7's client adapters, mail rides
// the ONE shell api-client (src/lib/api-client.tsx): session cookie, 401→refresh,
// requestId, error normalization. Callers never write fetch and never paste a token
// — the browser session authorizes every call. Send targets the user-facing
// /api/v1/mail/outbox (mail:send); the raw internal /mail/send stays 404 externally.
import type { common, mail } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";

type SendMailRequest = mail.SendMailRequest;
type SendMailResponse = mail.SendMailResponse;
type MailMessage = mail.MailMessage;
type Paginated<T> = common.Paginated<T>;

export interface InboxQuery {
  limit?: number;
  cursor?: string;
  threadId?: string;
}

export interface MailApi {
  /** Compose + send via the gateway (session-authorized, mail:send). */
  send(req: SendMailRequest): Promise<SendMailResponse>;
  /** List received messages (mail:read). */
  listInbox(query?: InboxQuery): Promise<Paginated<MailMessage>>;
}

const MAIL = "/api/v1/mail";

/** Build the mail api from the shell ApiClient (fed in composition, faked in tests). */
export function createMailApi(api: ApiClient): MailApi {
  return {
    send: (req) => api.request<SendMailResponse, SendMailRequest>({ method: "POST", path: `${MAIL}/outbox`, body: req }),
    listInbox: (query) => {
      const q: Record<string, string | number | boolean | undefined> = {};
      if (query?.limit !== undefined) q.limit = query.limit;
      if (query?.cursor !== undefined) q.cursor = query.cursor;
      if (query?.threadId !== undefined) q.threadId = query.threadId;
      const hasQuery = Object.keys(q).length > 0;
      return api.request<Paginated<MailMessage>>({ method: "GET", path: `${MAIL}/messages`, ...(hasQuery ? { query: q } : {}) });
    },
  };
}

// ---- compose form helpers (pure; unit-tested) ----

/** Parse a comma / newline / semicolon separated recipient string into MailAddress[].
 *  `Name <a@b.com>` and bare `a@b.com` are both accepted. Invalid tokens are dropped
 *  from the result and returned separately so the form can flag them. */
export function parseRecipients(raw: string): { recipients: mail.MailAddress[]; invalid: string[] } {
  const tokens = raw
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const recipients: mail.MailAddress[] = [];
  const invalid: string[] = [];
  for (const tok of tokens) {
    const named = /^(.*?)<([^>]+)>$/.exec(tok);
    const name = named ? named[1]!.trim() : "";
    const email = (named ? named[2]! : tok).trim();
    if (isValidEmail(email)) recipients.push(name ? { email, name } : { email });
    else invalid.push(tok);
  }
  return { recipients, invalid };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}
