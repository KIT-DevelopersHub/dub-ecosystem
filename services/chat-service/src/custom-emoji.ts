// Workspace custom emoji: list, image delivery, and the Slack import (emoji.list -> R2).
//
// A reaction keeps storing the literal ":name:" (chat_reactions.emoji — exactly what the Slack
// channel import already writes for custom emoji), so a row in chat_custom_emojis is all it
// takes for that text to render as an image. Image rows own R2 `custom-emoji/<name>` in
// dub-file-attachments with the ORIGINAL bytes and content type (GIF animation kept, nothing
// re-encoded); alias rows own no image and render their alias_of target.
//
// The import is a STATELESS, RESUMABLE batch: the browser POSTs `{ after }` and gets back
// `nextAfter`. One call = one emoji.list + at most EMOJI_IMPORT_BATCH CDN downloads/R2 puts +
// one D1 batch, inside the free-plan subrequest budget. Names already registered are skipped,
// so re-running (or two admins at once) is a no-op. A Slack 429 answers `retryAfterMs` with
// the same cursor instead of sleeping.
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { errors } from "@dub/errors";
import {
  type SlackClient,
  SlackApiError,
  compactStatements,
  customEmojiContentType,
  customEmojiR2Key,
  isValidCustomEmojiName,
  lit,
  parseSlackEmojiList,
} from "@dub/slack-import";

/** Downloads per call: 1 emoji.list + 20 fetches + 20 R2 puts + D1 stays under 50. */
export const EMOJI_IMPORT_BATCH = 20;
/** Slack caps custom emoji at 128KB; anything far larger is not an emoji. */
export const MAX_EMOJI_BYTES = 1024 * 1024;
const LIST_CACHE_MS = 60_000;

export type CustomEmojiSource = "slack" | "upload";

/** Wire shape of GET /chat/custom-emojis items. */
export interface CustomEmoji {
  name: string;
  /** Alias target name; null for an emoji that owns its image. */
  aliasOf: string | null;
  /** Stored content type of the image (null for an alias). */
  contentType: string | null;
  source: CustomEmojiSource;
  createdAt: string;
}

/** Wire shape of POST /chat/custom-emojis/slack-import. */
export interface EmojiImportResult {
  /** Importable custom emoji in Slack (images + their aliases); null when Slack was not reached. */
  total: number | null;
  /** Of `total`, how many are registered in Dub now. */
  imported: number;
  /** Rows this call registered. */
  added: number;
  /** Never importable: aliases of standard emoji, unsafe names / URLs. */
  skipped: number;
  /** Images this call attempted but could not store (download / type / size). */
  failed: string[];
  /** Cursor for the next call; null = this pass reached the end. */
  nextAfter: string | null;
  /** >0: Slack rate limit — call again with the same `after` after this many ms. */
  retryAfterMs: number;
}

export type EmojiBucket = Pick<R2Bucket, "put" | "get">;

export interface CustomEmojiDeps {
  db: D1Database;
  /** null when SLACK_BOT_TOKEN is not configured (import answers 412). */
  slack: SlackClient | null;
  /** null when the R2 binding is absent (import + image answer 412). */
  bucket: EmojiBucket | null;
  now: () => string;
  /** emoji.list memo inside one isolate (Tier 2 rate limit); 0 disables (tests). */
  listCacheMs?: number;
}

interface EmojiRow {
  name: string;
  r2_key: string | null;
  content_type: string | null;
  alias_of: string | null;
  source: CustomEmojiSource;
  created_at: string;
}

export interface EmojiImage {
  body: ReadableStream;
  contentType: string;
  etag: string;
  size: number;
}

const SLACK_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  missing_scope: "Slack アプリに emoji:read の権限がありません。管理者に追加を依頼してください。",
  invalid_auth: "Slack のトークンが無効です。管理者に SLACK_BOT_TOKEN の確認を依頼してください。",
};

// Module scope on purpose: deps are rebuilt per request, the isolate outlives them.
let listMemo: { at: number; map: Record<string, string> } | null = null;

function insertSql(row: { name: string; r2Key: string | null; contentType: string | null; aliasOf: string | null; createdBy: string; createdAt: string }): string {
  return `INSERT OR IGNORE INTO chat_custom_emojis (name, r2_key, content_type, alias_of, source, created_by, created_at)\nVALUES (${[
    lit(row.name),
    lit(row.r2Key),
    lit(row.contentType),
    lit(row.aliasOf),
    lit("slack"),
    lit(row.createdBy),
    lit(row.createdAt),
  ].join(", ")});`;
}

export class CustomEmojis {
  constructor(private readonly deps: CustomEmojiDeps) {}

  async list(): Promise<{ items: CustomEmoji[] }> {
    const res = await this.deps.db
      .prepare("SELECT name, r2_key, content_type, alias_of, source, created_at FROM chat_custom_emojis ORDER BY name")
      .all<EmojiRow>();
    return {
      items: (res.results ?? []).map((r) => ({ name: r.name, aliasOf: r.alias_of, contentType: r.content_type, source: r.source, createdAt: r.created_at })),
    };
  }

  /** The image of `name` (an alias resolves to its target). null = unknown / no object. */
  async image(name: string): Promise<EmojiImage | null> {
    if (!this.deps.bucket) throw errors.preconditionFailed("custom_emoji_storage_not_configured");
    if (!isValidCustomEmojiName(name)) return null;
    const row = await this.deps.db
      .prepare(
        `SELECT COALESCE(t.r2_key, e.r2_key) AS r2_key, COALESCE(t.content_type, e.content_type) AS content_type
         FROM chat_custom_emojis e LEFT JOIN chat_custom_emojis t ON t.name = e.alias_of
         WHERE e.name = ?`,
      )
      .bind(name)
      .first<{ r2_key: string | null; content_type: string | null }>();
    if (!row?.r2_key || !row.content_type) return null;
    const obj = await this.deps.bucket.get(row.r2_key);
    if (!obj) return null;
    return { body: obj.body as unknown as ReadableStream, contentType: row.content_type, etag: obj.httpEtag, size: obj.size };
  }

  /** One bounded, idempotent import batch starting after `after` (null = from the top). */
  async importFromSlack(after: string | null, createdBy: string): Promise<EmojiImportResult> {
    const slack = this.deps.slack;
    if (!slack) throw errors.preconditionFailed("emoji_import_not_configured: SLACK_BOT_TOKEN is not set on chat-service");
    const bucket = this.deps.bucket;
    if (!bucket) throw errors.preconditionFailed("custom_emoji_storage_not_configured");

    let map: Record<string, string>;
    try {
      map = await this.emojiMap(slack);
    } catch (e) {
      if (e instanceof SlackApiError && e.slackError === "rate_limited") {
        return { total: null, imported: await this.countSlackRows(), added: 0, skipped: 0, failed: [], nextAfter: after, retryAfterMs: (e.retryAfterSec ?? 30) * 1000 };
      }
      if (e instanceof SlackApiError) {
        throw errors.conflict(SLACK_ERROR_MESSAGES[e.slackError] ?? `Slack API エラー: ${e.slackError}`, { reason: e.slackError });
      }
      throw e;
    }

    const { images, aliases, invalid } = parseSlackEmojiList(map);
    const existing = new Set(
      ((await this.deps.db.prepare("SELECT name FROM chat_custom_emojis").all<{ name: string }>()).results ?? []).map((r) => r.name),
    );
    const now = this.deps.now();
    const statements: string[] = [];
    const failed: string[] = [];
    const registered = new Set(existing);

    // Images after the cursor that are not registered yet, in name order.
    const pending = images.filter((i) => (after === null || i.name > after) && !existing.has(i.name));
    const batch = pending.slice(0, EMOJI_IMPORT_BATCH);
    for (const img of batch) {
      const got = await slack.downloadEmoji(img.url);
      const type = got ? customEmojiContentType(got.contentType, img.url) : null;
      if (!got || !type || got.bytes.byteLength === 0 || got.bytes.byteLength > MAX_EMOJI_BYTES) {
        failed.push(img.name);
        continue;
      }
      const key = customEmojiR2Key(img.name);
      await bucket.put(key, got.bytes, { httpMetadata: { contentType: type, cacheControl: "private, max-age=86400" } });
      statements.push(insertSql({ name: img.name, r2Key: key, contentType: type, aliasOf: null, createdBy, createdAt: now }));
      registered.add(img.name);
    }

    // Aliases: no download, so every one whose target image is registered lands now. An alias
    // of a standard emoji (or of nothing) is never importable.
    const customImages = new Set(images.map((i) => i.name));
    let skipped = invalid.length;
    for (const a of aliases) {
      if (!customImages.has(a.target)) {
        skipped += 1;
        continue;
      }
      if (registered.has(a.name) || !registered.has(a.target)) continue;
      statements.push(insertSql({ name: a.name, r2Key: null, contentType: null, aliasOf: a.target, createdBy, createdAt: now }));
      registered.add(a.name);
    }

    if (statements.length > 0) {
      const compact = compactStatements(statements);
      await this.deps.db.batch(compact.map((s) => this.deps.db.prepare(s)));
    }

    const last = batch[batch.length - 1];
    const nextAfter = last && pending.length > batch.length ? last.name : null;
    const listed = [...images.map((i) => i.name), ...aliases.filter((a) => customImages.has(a.target)).map((a) => a.name)];
    return {
      total: listed.length,
      imported: listed.filter((n) => registered.has(n)).length,
      added: registered.size - existing.size,
      skipped,
      failed,
      nextAfter,
      retryAfterMs: 0,
    };
  }

  private async emojiMap(slack: SlackClient): Promise<Record<string, string>> {
    const ttl = this.deps.listCacheMs ?? LIST_CACHE_MS;
    const nowMs = Date.parse(this.deps.now());
    if (ttl > 0 && listMemo && nowMs - listMemo.at < ttl) return listMemo.map;
    const map = await slack.emojiList();
    if (ttl > 0) listMemo = { at: nowMs, map };
    return map;
  }

  private async countSlackRows(): Promise<number> {
    const row = await this.deps.db.prepare("SELECT COUNT(*) AS n FROM chat_custom_emojis WHERE source = 'slack'").first<{ n: number }>();
    return row?.n ?? 0;
  }
}
