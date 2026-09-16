// Slack Web API client for the history importer. Node-only (uses global fetch, Node
// >=20). `fetchImpl` is injectable so pagination/rate-limit behaviour is unit-testable
// without hitting the network (see test/slackClient.test.ts).
//
// Scopes required (bot token, Tier 3 — ~50+ req/min per method):
//   channels:read        conversations.list (public channels)
//   groups:read          conversations.list (private channels the bot is invited to)
//   channels:history      conversations.history / conversations.replies (public)
//   groups:history         conversations.history / conversations.replies (private)
//   users:read            users.list
//   users:read.email      users.list profile.email (needed for the identity_users join)
//   files:read            file metadata + url_private download
// The bot must be INVITED to every private (group) channel in scope before groups:history
// returns anything for it — Slack does not expose private-channel history otherwise.

export type FetchImpl = typeof fetch;

export interface SlackClientOptions {
  token: string;
  fetchImpl?: FetchImpl;
  /** Base delay (ms) before the first retry on 429; doubles per attempt if Slack omits
   *  Retry-After. Overridable for fast tests. */
  baseRetryDelayMs?: number;
  maxRetries?: number;
}

const SLACK_API_BASE = "https://slack.com/api";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly slackError: string,
  ) {
    super(`Slack API ${method} failed: ${slackError}`);
  }
}

export function createSlackClient(opts: SlackClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseRetryDelayMs = opts.baseRetryDelayMs ?? 1000;
  const maxRetries = opts.maxRetries ?? 5;

  async function call<T>(method: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    let attempt = 0;
    for (;;) {
      const res = await fetchImpl(`${SLACK_API_BASE}/${method}?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${opts.token}` },
      });
      if (res.status === 429) {
        if (attempt >= maxRetries) throw new SlackApiError(method, "rate_limited (max retries exceeded)");
        const retryAfterHeader = res.headers.get("Retry-After");
        const delayMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : baseRetryDelayMs * 2 ** attempt;
        await sleep(delayMs);
        attempt += 1;
        continue;
      }
      const body = (await res.json()) as { ok: boolean; error?: string } & T;
      if (!body.ok) throw new SlackApiError(method, body.error ?? "unknown_error");
      return body;
    }
  }

  return {
    /** All channels the bot can see (public + private it's a member of), paginated. */
    async listChannels(types = "public_channel,private_channel"): Promise<import("./slackImport").SlackChannel[]> {
      const out: import("./slackImport").SlackChannel[] = [];
      let cursor: string | undefined;
      do {
        const page = await call<{ channels: import("./slackImport").SlackChannel[]; response_metadata?: { next_cursor?: string } }>(
          "conversations.list",
          { types, limit: 200, cursor },
        );
        out.push(...page.channels);
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out;
    },

    async listUsers(): Promise<import("./slackImport").SlackUser[]> {
      const out: import("./slackImport").SlackUser[] = [];
      let cursor: string | undefined;
      do {
        const page = await call<{ members: import("./slackImport").SlackUser[]; response_metadata?: { next_cursor?: string } }>("users.list", {
          limit: 200,
          cursor,
        });
        out.push(...page.members);
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out;
    },

    /** Top-level messages only (thread replies are NOT included — fetch those via
     *  repliesForThread for any message with reply_count > 0). Oldest-first is not
     *  guaranteed by Slack (it's newest-first by default); callers should not assume
     *  order — resolveThreadRoots / mintMessageId don't depend on fetch order. */
    async historyForChannel(channelId: string): Promise<import("./slackImport").SlackMessage[]> {
      const out: import("./slackImport").SlackMessage[] = [];
      let cursor: string | undefined;
      do {
        const page = await call<{ messages: import("./slackImport").SlackMessage[]; response_metadata?: { next_cursor?: string } }>(
          "conversations.history",
          { channel: channelId, limit: 200, cursor },
        );
        out.push(...page.messages);
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out;
    },

    /** Full thread (root + all replies) for one thread_ts. */
    async repliesForThread(channelId: string, threadTs: string): Promise<import("./slackImport").SlackMessage[]> {
      const out: import("./slackImport").SlackMessage[] = [];
      let cursor: string | undefined;
      do {
        const page = await call<{ messages: import("./slackImport").SlackMessage[]; response_metadata?: { next_cursor?: string } }>(
          "conversations.replies",
          { channel: channelId, ts: threadTs, limit: 200, cursor },
        );
        out.push(...page.messages);
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out;
    },

    /** Download a file's body (url_private requires the same bot token as a Bearer
     *  header — NOT a query param, per Slack's docs). Returns null on any HTTP error
     *  so a single broken/expired attachment link never aborts the whole import. */
    async downloadFile(urlPrivate: string): Promise<ArrayBuffer | null> {
      const res = await fetchImpl(urlPrivate, { headers: { Authorization: `Bearer ${opts.token}` } });
      if (!res.ok) return null;
      return res.arrayBuffer();
    },
  };
}

export type SlackClient = ReturnType<typeof createSlackClient>;
