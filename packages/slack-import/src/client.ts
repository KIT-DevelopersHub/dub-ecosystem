// Slack Web API client for the history importer. Platform-neutral (global fetch only), so
// the Node CLI and the chat-service Worker share it. `fetchImpl` is injectable so
// pagination/rate-limit behaviour is unit-testable without the network (test/client.test.ts).
//
// Two call styles:
//  - whole-collection helpers (listChannels / historyForChannel / ...) for the offline CLI,
//    which follow every cursor and retry 429 with backoff;
//  - single-page helpers (*Page) for the Worker step engine, which must bound the number of
//    subrequests per invocation and persists the cursor itself. The Worker builds the client
//    with `maxRetries: 0`, so a 429 surfaces as SlackApiError.retryAfterSec instead of sleeping.
//
// Scopes required (bot token, Tier 3 — ~50+ req/min per method):
//   channels:read / groups:read          conversations.list (+ private channels the bot is in)
//   channels:history / groups:history    conversations.history / conversations.replies
//   channels:join                        conversations.join (public channels only)
//   users:read / users:read.email        users.list (+ profile.email for the account join)
//   files:read                           url_private download
//   bookmarks:read                       bookmarks.list
//   emoji:read                           emoji.list (custom emoji import; Tier 2 ~20 req/min)
// The bot must be INVITED to every private channel in scope. Public channels are joined.
import type { SlackBookmark, SlackChannel, SlackMessage, SlackUser } from "./mapping";
import { isSlackEmojiUrl } from "./emoji";

export type FetchImpl = typeof fetch;

export interface SlackClientOptions {
  token: string;
  fetchImpl?: FetchImpl;
  /** Base delay (ms) before the first retry on 429 when Slack omits Retry-After. */
  baseRetryDelayMs?: number;
  /** 0 = never sleep; a 429 throws SlackApiError("rate_limited") with retryAfterSec. */
  maxRetries?: number;
}

export interface SlackPage<T> {
  items: T[];
  /** Next cursor, or null when this was the last page. */
  nextCursor: string | null;
}

const SLACK_API_BASE = "https://slack.com/api";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly slackError: string,
    /** Seconds Slack asked us to wait (429 only). */
    public readonly retryAfterSec: number | null = null,
  ) {
    super(`Slack API ${method} failed: ${slackError}`);
    this.name = "SlackApiError";
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

export function createSlackClient(opts: SlackClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  const baseRetryDelayMs = opts.baseRetryDelayMs ?? 1000;
  const maxRetries = opts.maxRetries ?? 5;

  async function call<T>(method: string, params: Params): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${SLACK_API_BASE}/${method}?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${opts.token}` },
      });
      if (res.status === 429) {
        const header = res.headers.get("Retry-After");
        const retryAfterSec = header !== null && Number.isFinite(Number(header)) ? Number(header) : null;
        if (attempt >= maxRetries) throw new SlackApiError(method, "rate_limited", retryAfterSec ?? 30);
        await sleep(retryAfterSec !== null ? retryAfterSec * 1000 : baseRetryDelayMs * 2 ** attempt);
        continue;
      }
      const body = (await res.json()) as { ok: boolean; error?: string } & T;
      if (!body.ok) throw new SlackApiError(method, body.error ?? "unknown_error");
      return body;
    }
  }

  async function page<T>(method: string, key: string, params: Params): Promise<SlackPage<T>> {
    const res = await call<Record<string, unknown> & { response_metadata?: { next_cursor?: string } }>(method, params);
    return { items: (res[key] as T[] | undefined) ?? [], nextCursor: res.response_metadata?.next_cursor || null };
  }

  async function all<T>(fetchPage: (cursor: string | null) => Promise<SlackPage<T>>): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    do {
      const p: SlackPage<T> = await fetchPage(cursor);
      out.push(...p.items);
      cursor = p.nextCursor;
    } while (cursor);
    return out;
  }

  const channelsPage = (cursor: string | null, types = "public_channel,private_channel") =>
    page<SlackChannel>("conversations.list", "channels", { types, limit: 200, cursor });
  const usersPage = (cursor: string | null, limit = 200) => page<SlackUser>("users.list", "members", { limit, cursor });
  /** Top-level messages (newest first). Thread replies come from repliesPage. */
  const historyPage = (channelId: string, cursor: string | null, limit = 200) =>
    page<SlackMessage>("conversations.history", "messages", { channel: channelId, limit, cursor });
  /** One thread: root + replies (oldest first). */
  const repliesPage = (channelId: string, threadTs: string, cursor: string | null, limit = 200) =>
    page<SlackMessage>("conversations.replies", "messages", { channel: channelId, ts: threadTs, limit, cursor });
  const membersPage = (channelId: string, cursor: string | null) =>
    page<string>("conversations.members", "members", { channel: channelId, limit: 200, cursor });

  return {
    channelsPage,
    usersPage,
    historyPage,
    repliesPage,
    membersPage,

    /** All channels the bot can see (public + private it's a member of). */
    listChannels: (types?: string) => all((c) => channelsPage(c, types)),
    listUsers: () => all((c) => usersPage(c)),
    historyForChannel: (channelId: string) => all((c) => historyPage(channelId, c)),
    repliesForThread: (channelId: string, threadTs: string) => all((c) => repliesPage(channelId, threadTs, c)),
    membersOfChannel: (channelId: string) => all((c) => membersPage(channelId, c)),

    async bookmarksForChannel(channelId: string): Promise<SlackBookmark[]> {
      const res = await call<{ bookmarks?: SlackBookmark[] }>("bookmarks.list", { channel_id: channelId });
      return res.bookmarks ?? [];
    },

    /** Join a public channel (no-op if already a member). Private channels need an invite. */
    async joinChannel(channelId: string): Promise<void> {
      await call("conversations.join", { channel: channelId });
    },

    /**
     * The workspace's custom emoji: name -> image URL or "alias:<name>". Slack answers the whole
     * map in one call; a `response_metadata.next_cursor`, if ever present, is followed.
     */
    async emojiList(): Promise<Record<string, string>> {
      const out: Record<string, string> = {};
      let cursor: string | null = null;
      do {
        const res: { emoji?: Record<string, string>; response_metadata?: { next_cursor?: string } } = await call("emoji.list", { cursor });
        Object.assign(out, res.emoji ?? {});
        cursor = res.response_metadata?.next_cursor || null;
      } while (cursor);
      return out;
    },

    /**
     * Download an emoji image from Slack's public CDN. No Authorization header (the token
     * never leaves for a CDN host), only *.slack-edge.com URLs, no redirects, at most
     * `maxBytes`. Null on any failure so one broken emoji never aborts the batch.
     */
    async downloadEmoji(url: string, maxBytes = 1024 * 1024): Promise<{ bytes: ArrayBuffer; contentType: string | null } | null> {
      if (!isSlackEmojiUrl(url)) return null;
      try {
        // redirect "error": a 3xx can never walk the fetch off the *.slack-edge.com allow-list.
        const res = await fetchImpl(url, { redirect: "error" });
        if (!res.ok) return null;
        const declared = Number(res.headers.get("content-length") ?? "0");
        if (declared > maxBytes) {
          await res.body?.cancel().catch(() => undefined);
          return null;
        }
        const bytes = await res.arrayBuffer();
        return bytes.byteLength > maxBytes ? null : { bytes, contentType: res.headers.get("content-type") };
      } catch {
        return null;
      }
    },

    /** Download a file body (url_private takes the bot token as a Bearer header). Null on
     *  any HTTP error so one broken attachment never aborts the whole import. */
    async downloadFile(urlPrivate: string): Promise<ArrayBuffer | null> {
      const res = await fetchImpl(urlPrivate, { headers: { Authorization: `Bearer ${opts.token}` } });
      if (!res.ok) return null;
      return res.arrayBuffer();
    },
  };
}

export type SlackClient = ReturnType<typeof createSlackClient>;
