import { describe, expect, it, vi } from "vitest";
import type { CustomEmoji, EmojiImportResult } from "../api/contract";
import { driveEmojiImport, filterCustomEmojis, resolveCustomEmoji, shortcodeName, toShortcode, describeEmojiImportError } from "./custom-emoji";
import { createCustomEmojiSim, DEMO_EMOJI_BATCH } from "./custom-emoji-demo";

const e = (name: string, aliasOf: string | null = null): CustomEmoji => ({ name, aliasOf, contentType: aliasOf ? null : "image/png", source: "slack", createdAt: "x" });

describe("shortcodes", () => {
  it("reads :name: and leaves Unicode glyphs alone", () => {
    expect(shortcodeName(":partyparrot:")).toBe("partyparrot");
    expect(shortcodeName(":kit-dev:")).toBe("kit-dev");
    expect(shortcodeName("👍")).toBeNull();
    expect(shortcodeName(":a b:")).toBeNull();
    expect(toShortcode("x")).toBe(":x:");
  });

  it("resolves an alias to its target and drops a dangling alias", () => {
    const byName = new Map([e("partyparrot"), e("parrot", "partyparrot"), e("ghost", "gone")].map((x) => [x.name, x] as const));
    expect(resolveCustomEmoji(byName, "parrot")?.name).toBe("partyparrot");
    expect(resolveCustomEmoji(byName, "partyparrot")?.name).toBe("partyparrot");
    expect(resolveCustomEmoji(byName, "ghost")).toBeNull();
    expect(resolveCustomEmoji(byName, "nope")).toBeNull();
  });

  it("filters by name (case-insensitive, colons ignored)", () => {
    const list = [e("kit-dev"), e("partyparrot"), e("parrot", "partyparrot")];
    expect(filterCustomEmojis(list, ":PARR").map((x) => x.name)).toEqual(["partyparrot", "parrot"]);
    expect(filterCustomEmojis(list, "  ")).toHaveLength(3);
  });

  it("maps HTTP errors to readable text", () => {
    expect(describeEmojiImportError({ status: 412 })).toContain("SLACK_BOT_TOKEN");
    expect(describeEmojiImportError({ status: 403 })).toContain("権限");
    expect(describeEmojiImportError({ status: 409, message: "emoji:read がありません" })).toContain("emoji:read");
  });
});

describe("driveEmojiImport", () => {
  const r = (over: Partial<EmojiImportResult>): EmojiImportResult => ({ total: 3, imported: 0, added: 0, skipped: 0, failed: [], nextAfter: null, retryAfterMs: 0, ...over });

  it("follows the cursor, waits out a rate limit with the same cursor, and stops at nextAfter null", async () => {
    const calls: (string | null)[] = [];
    const answers = [r({ imported: 1, added: 1, nextAfter: "a" }), r({ total: null, retryAfterMs: 5000, nextAfter: "a" }), r({ imported: 3, added: 2 })];
    const api = { importSlackEmojis: vi.fn(async (after: string | null) => (calls.push(after), answers.shift()!)) };
    const sleeps: number[] = [];
    const updates: EmojiImportResult[] = [];
    const last = await driveEmojiImport(api, { onUpdate: (x) => updates.push(x), sleep: async (ms) => void sleeps.push(ms) });
    expect(calls).toEqual([null, "a", "a"]);
    expect(sleeps).toContain(5000);
    expect(updates).toHaveLength(3);
    expect(last?.imported).toBe(3);
  });

  it("stops when aborted", async () => {
    const ctrl = new AbortController();
    const api = { importSlackEmojis: vi.fn(async () => (ctrl.abort(), r({ nextAfter: "z" }))) };
    await driveEmojiImport(api, { onUpdate: () => undefined, signal: ctrl.signal, sleep: async () => undefined });
    expect(api.importSlackEmojis).toHaveBeenCalledTimes(1);
  });
});

describe("custom emoji demo sim", () => {
  it("imports in batches, registers custom aliases, skips the standard alias, and is idempotent", () => {
    const sim = createCustomEmojiSim({ now: () => "2026-10-18T00:00:00.000Z" });
    expect(sim.list().map((x) => x.name)).toEqual(["devhub", "kit-dev"]);
    expect(sim.image("partyparrot")).toBeNull();

    let after: string | null = null;
    let last: EmojiImportResult | null = null;
    let calls = 0;
    do {
      last = sim.importStep(after);
      after = last.nextAfter;
      calls += 1;
    } while (after);
    expect(calls).toBeGreaterThan(1);
    expect(last).toMatchObject({ total: 15, imported: 15, skipped: 1, nextAfter: null });
    expect(sim.list().find((x) => x.name === "parrot")?.aliasOf).toBe("partyparrot");
    expect(sim.image("parrot")?.body).toContain("<animate");
    expect(sim.importStep(null).added).toBe(0);
    expect(DEMO_EMOJI_BATCH).toBeGreaterThan(0);
  });
});
