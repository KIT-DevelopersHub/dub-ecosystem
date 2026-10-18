// Custom emoji (src/custom-emoji.ts): the Slack import batch against a fake Slack client and
// an in-memory SQLite built from the real physical migrations, plus the HTTP routes + authz.
import { beforeEach, describe, expect, it } from "vitest";
import { type SlackClient, SlackApiError } from "@dub/slack-import";
import { CustomEmojis, EMOJI_IMPORT_BATCH, MAX_EMOJI_BYTES, type CustomEmojiDeps, type EmojiBucket, type EmojiImportResult } from "../src/custom-emoji";
import { count, makeImportD1, type RawDb } from "./import-d1";
import { ALL_CHAT_KEYS, createApp, fakeAuthz, makeDeps } from "./harness";

const ADMIN = "usr_admin";
const CDN = "https://emoji.slack-edge.com/T0";

class FakeSlack {
  calls: string[] = [];
  failList: Error[] = [];
  emoji: Record<string, string> = {
    "kit-dev": `${CDN}/kit-dev/1.png`,
    partyparrot: `${CDN}/partyparrot/2.gif`,
    parrot: "alias:partyparrot", // alias of a custom emoji -> imported, no image
    thumbsup_all: "alias:thumbsup", // alias of a standard emoji -> skipped
    broken: `${CDN}/broken/3.png`, // CDN answers 404
    huge: `${CDN}/huge/4.png`, // over MAX_EMOJI_BYTES
    vector: `${CDN}/vector/5.svg`, // SVG: never stored
    "bad/name": `${CDN}/x/6.png`, // unsafe name -> skipped
  };

  client(): SlackClient {
    const api = {
      emojiList: async () => {
        this.calls.push("emoji.list");
        const e = this.failList.shift();
        if (e) throw e;
        return { ...this.emoji };
      },
      downloadEmoji: async (url: string) => {
        this.calls.push(`download ${url}`);
        if (url.includes("/broken/")) return null;
        if (url.includes("/huge/")) return { bytes: new ArrayBuffer(MAX_EMOJI_BYTES + 1), contentType: "image/png" };
        if (url.endsWith(".svg")) return { bytes: new TextEncoder().encode("<svg/>").buffer, contentType: "image/svg+xml" };
        const type = url.endsWith(".gif") ? "image/gif" : "image/png";
        return { bytes: new TextEncoder().encode(url).buffer, contentType: type };
      },
    };
    return api as unknown as SlackClient;
  }
}

class FakeBucket {
  objects = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();
  async put(key: string, v: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { bytes: new Uint8Array(v), contentType: opts?.httpMetadata?.contentType });
    return null;
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { body: new Response(o.bytes).body, httpEtag: `"etag-${key}"`, size: o.bytes.byteLength };
  }
}

let raw: RawDb;
let db: ReturnType<typeof makeImportD1>["d1"];
let slack: FakeSlack;
let bucket: FakeBucket;
let emojis: CustomEmojis;

function build(overrides: Partial<CustomEmojiDeps> = {}): CustomEmojis {
  return new CustomEmojis({
    db,
    slack: slack.client(),
    bucket: bucket as unknown as EmojiBucket,
    now: () => "2026-10-18T00:00:00.000Z",
    listCacheMs: 0,
    ...overrides,
  });
}

beforeEach(() => {
  const made = makeImportD1();
  db = made.d1;
  raw = made.raw;
  slack = new FakeSlack();
  bucket = new FakeBucket();
  emojis = build();
});

async function runToEnd(target: CustomEmojis = emojis): Promise<{ last: EmojiImportResult; calls: number; failed: string[] }> {
  let after: string | null = null;
  const failed: string[] = [];
  for (let calls = 1; calls <= 50; calls++) {
    const r = await target.importFromSlack(after, ADMIN);
    failed.push(...r.failed);
    if (r.retryAfterMs > 0) continue;
    if (r.nextAfter === null) return { last: r, calls, failed };
    after = r.nextAfter;
  }
  throw new Error("import did not finish");
}

const row = (name: string) => raw.prepare("SELECT * FROM chat_custom_emojis WHERE name = ?").get(name) as Record<string, unknown> | undefined;

describe("CustomEmojis.importFromSlack", () => {
  it("stores images as-is in R2 (custom-emoji/), registers aliases, skips what cannot be imported", async () => {
    const { last, failed } = await runToEnd();
    expect(last).toMatchObject({ total: 6, imported: 3, skipped: 2, nextAfter: null, retryAfterMs: 0 });
    expect(failed.sort()).toEqual(["broken", "huge", "vector"]);

    expect(row("partyparrot")).toMatchObject({ r2_key: "custom-emoji/partyparrot", content_type: "image/gif", alias_of: null, source: "slack", created_by: ADMIN });
    expect(row("parrot")).toMatchObject({ r2_key: null, content_type: null, alias_of: "partyparrot" });
    expect(row("thumbsup_all")).toBeUndefined();
    expect(row("bad/name")).toBeUndefined();
    expect(row("vector")).toBeUndefined();

    // original bytes + original type, nothing re-encoded
    const gif = bucket.objects.get("custom-emoji/partyparrot")!;
    expect(gif.contentType).toBe("image/gif");
    expect(new TextDecoder().decode(gif.bytes)).toBe(`${CDN}/partyparrot/2.gif`);
    expect([...bucket.objects.keys()].sort()).toEqual(["custom-emoji/kit-dev", "custom-emoji/partyparrot"]);
  });

  it("is idempotent: a second pass downloads nothing new and adds no rows", async () => {
    await runToEnd();
    const before = count(raw, "chat_custom_emojis");
    slack.calls = [];
    const { last } = await runToEnd();
    expect(last.added).toBe(0);
    expect(count(raw, "chat_custom_emojis")).toBe(before);
    // only the three that failed before are retried
    expect(slack.calls.filter((c) => c.startsWith("download")).length).toBe(3);
  });

  it("works in bounded batches with a name cursor and lands an alias once its target exists", async () => {
    slack.emoji = {};
    for (let i = 0; i < EMOJI_IMPORT_BATCH + 5; i++) slack.emoji[`e${String(i).padStart(2, "0")}`] = `${CDN}/e${i}/x.png`;
    slack.emoji.zz_alias = "alias:e24"; // target is in the SECOND batch

    const first = await emojis.importFromSlack(null, ADMIN);
    expect(first).toMatchObject({ total: 26, imported: EMOJI_IMPORT_BATCH, added: EMOJI_IMPORT_BATCH, nextAfter: "e19" });
    expect(slack.calls.filter((c) => c.startsWith("download")).length).toBe(EMOJI_IMPORT_BATCH);
    expect(row("zz_alias")).toBeUndefined();

    const second = await emojis.importFromSlack(first.nextAfter, ADMIN);
    expect(second).toMatchObject({ total: 26, imported: 26, added: 6, nextAfter: null });
    expect(row("zz_alias")).toMatchObject({ alias_of: "e24" });
  });

  it("answers retryAfterMs with the same cursor on a Slack 429 (no sleeping, no writes)", async () => {
    slack.failList.push(new SlackApiError("emoji.list", "rate_limited", 7));
    const r = await emojis.importFromSlack("kit-dev", ADMIN);
    expect(r).toMatchObject({ total: null, added: 0, nextAfter: "kit-dev", retryAfterMs: 7000 });
    expect(count(raw, "chat_custom_emojis")).toBe(0);
  });

  it("maps a missing emoji:read scope to a 409 with a readable message", async () => {
    slack.failList.push(new SlackApiError("emoji.list", "missing_scope"));
    await expect(emojis.importFromSlack(null, ADMIN)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("emoji:read") });
  });

  it("is not configured without a token or a bucket (412)", async () => {
    await expect(build({ slack: null }).importFromSlack(null, ADMIN)).rejects.toMatchObject({ status: 412 });
    await expect(build({ bucket: null }).importFromSlack(null, ADMIN)).rejects.toMatchObject({ status: 412 });
  });
});

describe("CustomEmojis.list / image", () => {
  it("lists rows by name and resolves an alias to its target's image", async () => {
    await runToEnd();
    const { items } = await emojis.list();
    expect(items.map((i) => [i.name, i.aliasOf, i.contentType])).toEqual([
      ["kit-dev", null, "image/png"],
      ["parrot", "partyparrot", null],
      ["partyparrot", null, "image/gif"],
    ]);
    const img = await emojis.image("parrot");
    expect(img).toMatchObject({ contentType: "image/gif", etag: '"etag-custom-emoji/partyparrot"' });
    expect(await new Response(img!.body).text()).toBe(`${CDN}/partyparrot/2.gif`);
    expect(await emojis.image("nope")).toBeNull();
    expect(await emojis.image("../etc")).toBeNull();
  });
});

describe("custom emoji routes", () => {
  const IMPORTER_KEYS: typeof ALL_CHAT_KEYS = [...ALL_CHAT_KEYS, "chat:emoji_import"];
  const app = (customEmoji: CustomEmojis | undefined, keys = IMPORTER_KEYS) => createApp(makeDeps({ customEmoji, authz: fakeAuthz(new Set(keys)) }));
  const req = (a: ReturnType<typeof app>, method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) =>
    a.request(`http://svc${path}`, {
      method,
      headers: { "x-dub-request-id": "req_test", "x-dub-user-id": ADMIN, ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

  it("imports over HTTP, lists, and serves the image bytes with cache + safety headers", async () => {
    const a = app(emojis);
    const imported = await req(a, "POST", "/chat/custom-emojis/slack-import", { body: {} });
    expect(imported.status).toBe(200);
    expect(((await imported.json()) as EmojiImportResult).imported).toBe(3);

    const list = await req(a, "GET", "/chat/custom-emojis");
    expect(((await list.json()) as { items: { name: string }[] }).items.map((i) => i.name)).toEqual(["kit-dev", "parrot", "partyparrot"]);

    const img = await req(a, "GET", "/chat/custom-emojis/partyparrot/image");
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/gif");
    expect(img.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await img.text()).toBe(`${CDN}/partyparrot/2.gif`);

    const cached = await req(a, "GET", "/chat/custom-emojis/partyparrot/image", { headers: { "if-none-match": img.headers.get("etag")! } });
    expect(cached.status).toBe(304);
    expect((await req(a, "GET", "/chat/custom-emojis/nope/image")).status).toBe(404);
  });

  it("400s a non-string cursor", async () => {
    expect((await req(app(emojis), "POST", "/chat/custom-emojis/slack-import", { body: { after: 3 } })).status).toBe(400);
  });

  it("a reader (閲覧 only) can list + load images but not import", async () => {
    await runToEnd();
    const a = app(emojis, ["app:chat:view"]);
    expect((await req(a, "GET", "/chat/custom-emojis")).status).toBe(200);
    expect((await req(a, "GET", "/chat/custom-emojis/kit-dev/image")).status).toBe(200);
    expect((await req(a, "POST", "/chat/custom-emojis/slack-import", { body: {} })).status).toBe(403);
  });

  it("needs chat:emoji_import: 編集 + every other chat key (incl. chat:slack_import) still gets 403", async () => {
    const a = app(emojis, [...ALL_CHAT_KEYS, "chat:slack_import"]);
    expect((await req(a, "POST", "/chat/custom-emojis/slack-import", { body: {} })).status).toBe(403);
    expect(count(raw, "chat_custom_emojis")).toBe(0);
  });

  it("without the module: empty list, 412 on image / import", async () => {
    const a = app(undefined);
    expect(await (await req(a, "GET", "/chat/custom-emojis")).json()).toEqual({ items: [] });
    expect((await req(a, "GET", "/chat/custom-emojis/x/image")).status).toBe(412);
    expect((await req(a, "POST", "/chat/custom-emojis/slack-import", { body: {} })).status).toBe(412);
  });
});
