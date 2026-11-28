// AI digest + Q&A (#879): PII exclusion in collectors, diff-only runs, discrepancies,
// flag-OFF behaviour, the 「停止中」 offline state, the schedule, and the Mac mini gate.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createDbClient } from "@dub/db";
import { makeDeps, call, createApp, EDITOR, VIEWER } from "./harness";
import { fakeAuthz } from "./harness";
import { makeD1 } from "./d1";
import { redactPii, safeText, REDACTED } from "../src/digest/pii";
import { mapChat, mapMail, mapSponsors, mapTickets, mapTasks, mapLp, mapEvent, mapMeetings, mapDrive } from "../src/digest/collectors";
import { canonical, changedSources, hashAll } from "../src/digest/diff";
import { findDiscrepancies } from "../src/digest/discrepancy";
import { createFakeProvider, createOfflineProvider } from "../src/digest/providers";
import { createRelayProvider } from "../src/digest/relay-provider";
import { InMemoryDigestRepo, createD1DigestRepo } from "../src/digest/repo";
import { runDigest, sanitizeLines } from "../src/digest/runner";
import { nextDigestRunAt, FINAL_WEEK_INTERVAL_MS } from "../src/digest/schedule";
import { parseAgentFrame } from "../src/digest-hub";
import { agentUpgradeAllowed } from "../src/index";
import { secretEquals } from "../src/digest/secret";
import type { Collector, DigestDeps, LlmProvider, SourceSnapshot } from "../src/digest/types";
import type { EventRow } from "../src/types";
import { EMPTY_EVENT_DETAILS } from "../src/domain";

const NOW = "2026-08-09T00:00:00.000Z";

function row(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "event_1", orgId: "org_devhub", title: "北陸ITカンファレンス", description: null, phase: "preparing",
    startsAt: "2026-09-13T00:00:00.000Z", endsAt: null, venue: "金沢工業大学", capacity: 300,
    archivedAt: null, version: 1, createdBy: "user_a", createdAt: NOW, updatedAt: NOW, ...over,
  };
}

function digestDeps(over: Partial<DigestDeps> = {}): DigestDeps & { repo: InMemoryDigestRepo } {
  const repo = new InMemoryDigestRepo();
  return { enabled: true, provider: createFakeProvider(), collectors: [], repo, ...over } as DigestDeps & { repo: InMemoryDigestRepo };
}

function staticCollector(snap: SourceSnapshot): Collector & { snap: SourceSnapshot } {
  const c = { source: snap.source, snap, async collect() { return c.snap; } };
  return c;
}

const allText = (s: SourceSnapshot) => JSON.stringify(s);

describe("PII redaction", () => {
  it("masks emails, phone numbers and long digit runs, keeps dates and counts", () => {
    const out = redactPii("連絡は taro@example.com か 090-1234-5678、学籍番号 1234567。9/13 開催 2026-09-13、残り 120枚");
    expect(out).not.toContain("taro@example.com");
    expect(out).not.toContain("090-1234-5678");
    expect(out).not.toContain("1234567");
    expect(out).toContain("2026-09-13");
    expect(out).toContain("120枚");
    expect(out.split(REDACTED).length - 1).toBe(3);
  });
  it("safeText bounds and redacts; non-strings become empty", () => {
    expect(safeText("a".repeat(500), 10)).toBe(`${"a".repeat(10)}…`);
    expect(safeText({ email: "x@y.jp" })).toBe("");
    expect(safeText("+81 90 1234 5678")).toBe(REDACTED);
  });
});

describe("collectors only pass allowlisted fields (PII exclusion)", () => {
  it("mail: subject + sender domain only — never the body or the address", () => {
    const snap = mapMail({
      items: [{ id: "m1", subject: "協賛のご相談", from: "Taro Yamada <taro@sponsor.co.jp>", body: "電話 076-123-4567 まで", text: "secret body" }],
    });
    const s = allText(snap);
    expect(snap.items[0]!.text).toBe("メール「協賛のご相談」（sponsor.co.jp）");
    expect(s).not.toContain("taro@");
    expect(s).not.toContain("Taro Yamada");
    expect(s).not.toContain("076-123-4567");
    expect(s).not.toContain("secret body");
  });
  it("sponsors: company + stage; contact name / email / phone dropped", () => {
    const snap = mapSponsors({ items: [{ id: "s1", companyName: "株式会社A", stage: "提案中", contactName: "佐藤花子", email: "hanako@a.jp", phone: "03-1234-5678" }] });
    const s = allText(snap);
    expect(snap.items[0]!.text).toBe("協賛「株式会社A」提案中");
    for (const leaked of ["佐藤花子", "hanako@a.jp", "03-1234-5678"]) expect(s).not.toContain(leaked);
  });
  it("tickets: counts per type only — orders and buyers are never read", () => {
    const snap = mapTickets({
      types: [{ id: "t1", name: "一般", active: true, stats: { sold: 120, pending: 3, remaining: 80, revenueJpy: 360000 } }],
      orders: [{ buyerName: "山田太郎", email: "buyer@x.jp" }],
    });
    const s = allText(snap);
    expect(snap.items[0]!.text).toBe("券種「一般」販売 120枚・残り 80枚");
    expect(s).not.toContain("山田太郎");
    expect(s).not.toContain("buyer@x.jp");
    expect(s).not.toContain("360000");
  });
  it("chat: only pinned or 決定/確定 messages; chatter and authors are dropped", () => {
    const snap = mapChat(
      { items: [
        { id: "c1", body: "お昼なに食べる？", authorId: "user_x", authorName: "鈴木" },
        { id: "c2", body: "【決定】懇親会は 18:30 から", authorName: "鈴木" },
        { id: "c3", body: "会場図を共有します（担当: kenta@kit.ac.jp）", authorName: "田中" },
      ] },
      new Set(["c3"]),
      "event_1",
    );
    expect(snap.items.map((i) => i.key)).toEqual(["c2", "c3"]);
    const s = allText(snap);
    expect(s).not.toContain("お昼");
    expect(s).not.toContain("鈴木");
    expect(s).not.toContain("kenta@kit.ac.jp");
    expect(snap.items.every((i) => i.link === "/chat?eventId=event_1")).toBe(true);
  });
  it("tasks: open + due within 7 days (or overdue); no description / assignee id", () => {
    const snap = mapTasks({ items: [
      { id: "k1", title: "会場予約", status: "todo", dueAt: "2026-08-05T00:00:00.000Z", description: "連絡先 a@b.jp", assigneeId: "user_9" },
      { id: "k2", title: "後で", status: "todo", dueAt: "2026-12-01T00:00:00.000Z" },
      { id: "k3", title: "済み", status: "done", dueAt: "2026-08-08T00:00:00.000Z" },
    ] }, NOW);
    expect(snap.items).toEqual([{ source: "tasks", key: "k1", text: "タスク「会場予約」期限 2026-08-05（遅れ）", link: "/tasks/k1" }]);
    expect(allText(snap)).not.toContain("user_9");
  });
  it("meetings / drive keep date+title / file name only, drive limited to the chosen folder", () => {
    const m = mapMeetings({ items: [{ id: "g1", title: "定例", startsAt: "2026-08-10T10:00:00.000Z", attendees: ["a@b.jp"] }] }, NOW);
    expect(allText(m)).not.toContain("a@b.jp");
    const d = mapDrive({ files: [
      { id: "f1", name: "企画書", parents: ["folder_ok"], webViewLink: "https://drive.google.com/f1" },
      { id: "f2", name: "名簿", parents: ["folder_other"] },
    ] }, "folder_ok");
    expect(d.items.map((i) => i.key)).toEqual(["f1"]);
  });
});

describe("diffing", () => {
  it("canonical JSON ignores key order", () => {
    expect(canonical({ b: 1, a: [1, { y: 2, x: 1 }] })).toBe(canonical({ a: [1, { x: 1, y: 2 }], b: 1 }));
  });
  it("changedSources: new or moved hashes only; a vanished source is not a change", () => {
    expect(changedSources({ tasks: "a", lp: "b", mail: "c" }, { tasks: "a", lp: "B", chat: "d" })).toEqual(["chat", "lp"]);
  });
  it("a second run with nothing changed makes no provider call and no D1 write", async () => {
    const provider = createFakeProvider();
    const summarize = vi.spyOn(provider, "summarize");
    const tasks = staticCollector(mapTasks({ items: [{ id: "k1", title: "会場予約", status: "todo", dueAt: "2026-08-10T00:00:00.000Z" }] }, NOW));
    const deps = digestDeps({ provider, collectors: [tasks] });
    const input = { ev: row(), actions: [], details: null, trigger: "manual" as const, ctx: { requestId: "r", userId: "u", eventId: "event_1", now: NOW } };

    const first = await runDigest(deps, input);
    expect(first.ran).toBe(true);
    expect(first.changedSources).toEqual(["actions", "event", "tasks"]);
    const writes = deps.repo.writes;

    const second = await runDigest(deps, input);
    expect(second.ran).toBe(false);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(deps.repo.writes).toBe(writes);

    tasks.snap = mapTasks({ items: [{ id: "k1", title: "会場予約（変更）", status: "todo", dueAt: "2026-08-10T00:00:00.000Z" }] }, NOW);
    const third = await runDigest(deps, input);
    expect(third.changedSources).toEqual(["tasks"]);
    expect(summarize.mock.calls[1]![0].changed.map((s) => s.source)).toEqual(["tasks"]);
  });
  it("hashAll is stable across runs", async () => {
    const s = mapTickets({ types: [{ id: "t1", name: "一般", stats: { sold: 1, remaining: 2 } }] });
    expect(await hashAll([s])).toEqual(await hashAll([structuredClone(s)]));
  });
});

describe("cited lines and discrepancies", () => {
  it("drops lines whose link no collector produced, and re-redacts provider output", () => {
    const snaps = [mapTasks({ items: [{ id: "k1", title: "x", status: "todo", dueAt: "2026-08-10T00:00:00.000Z" }] }, NOW)];
    const out = sanitizeLines([
      { text: "ok 090-1111-2222", source: "tasks", link: "/tasks/k1" },
      { text: "invented", source: "tasks", link: "/tasks/nope" },
      { text: "no link", source: "tasks", link: "" },
    ], snaps);
    expect(out).toEqual([{ text: `ok ${REDACTED}`, source: "tasks", link: "/tasks/k1" }]);
  });
  it("LP date / legacy free-text venue+capacity that disagree with the event are reported, not fixed", () => {
    const lp = mapLp({ published: { layout: { content: { news: [{ id: "n1", date: "2026-07-01", text: "開催日: 2026年9月14日 会場: 石川県立図書館", url: "" }] } } } }, "https://hokuriku-it-conf.com");
    const legacy = mapEvent(row(), { venue: "金沢工業大学 扇が丘", capacity: "250名" } as never);
    const ds = findDiscrepancies({ id: "event_1", title: "t", startsAt: "2026-09-13T00:00:00.000Z", venue: "金沢工業大学", capacity: 300 }, [lp, legacy]);
    expect(ds).toEqual([
      { field: "startsAt", eventValue: "2026-09-13", sourceValue: "2026-09-14", source: "lp", link: "https://hokuriku-it-conf.com" },
      { field: "venue", eventValue: "金沢工業大学", sourceValue: "石川県立図書館", source: "lp", link: "https://hokuriku-it-conf.com" },
      { field: "capacity", eventValue: "300", sourceValue: "250", source: "event", link: "/events?eventId=event_1" },
    ]);
  });
});

describe("HTTP: flag OFF (the production default)", () => {
  for (const [label, digest] of [["no digest deps", undefined], ["enabled:false", digestDeps({ enabled: false })]] as const) {
    it(`${label}: GET says disabled, run is 409, ask answers "disabled" — nothing is called`, async () => {
      const deps = makeDeps(digest ? { digest } : {});
      deps.repo.seedEvent(row());
      const app = createApp(deps);
      const get = await call(app, "GET", "/events/event_1/digest");
      expect(get.status).toBe(200);
      expect(get.json).toMatchObject({ enabled: false, provider: { status: "disabled" }, digest: null });
      const run = await call(app, "POST", "/events/event_1/digest/run");
      expect(run.status).toBe(409);
      expect(run.json.error.code).toBe("EVENT_AI_DIGEST_DISABLED");
      const ask = await call(app, "POST", "/events/event_1/ask", { body: { question: "会場は？" } });
      expect(ask.json).toEqual({ status: "disabled", answer: null, sources: [] });
      expect(deps.audit.records).toHaveLength(0);
    });
  }
});

describe("HTTP: flag OFF preview (no LLM, members can read)", () => {
  it("a viewer gets the event's own lines + 食い違い; nothing remote is called, nothing stored", async () => {
    const remote = staticCollector({ source: "tasks", items: [] });
    const collect = vi.spyOn(remote, "collect");
    const digest = digestDeps({ enabled: false, collectors: [remote] });
    const deps = makeDeps({ digest, ...fakeAuthz(VIEWER) });
    deps.repo.seedEvent(row());
    deps.repo.seedAction({ id: "act_1", eventId: "event_1", kind: "task", title: "会場予約", sortOrder: 1, archivedAt: null, version: 1, createdBy: "user_a", createdAt: NOW, updatedAt: NOW });
    await deps.repo.upsertEventDetails({ eventId: "event_1", data: { ...EMPTY_EVENT_DETAILS, venue: "金沢工業大学", capacity: "250名" }, version: 1, updatedBy: "user_a", updatedAt: NOW }, 0);
    const app = createApp(deps);
    const get = await call(app, "GET", "/events/event_1/digest");
    expect(get.status).toBe(200);
    expect(get.json.digest).toBeNull();
    expect(get.json.preview.lines.map((l: { source: string }) => l.source)).toEqual(["event", "actions"]);
    expect(get.json.preview.lines[1]).toEqual({ text: "アクション「会場予約」", source: "actions", link: "/events/event_1" });
    expect(get.json.preview.discrepancies).toEqual([
      { field: "capacity", eventValue: "300", sourceValue: "250", source: "event", link: "/events?eventId=event_1" },
    ]);
    expect(collect).not.toHaveBeenCalled();
    expect(await digest.repo.getDigest("event_1")).toBeNull();
    // 変更系は管理者のまま
    expect((await call(app, "POST", "/events/event_1/digest/run")).status).toBe(403);
  });
});

describe("HTTP: enabled but the Mac mini is offline (「停止中」, no fallback)", () => {
  it("GET reports offline, run is 503, ask answers offline", async () => {
    const deps = makeDeps({ digest: digestDeps({ provider: createOfflineProvider() }) });
    deps.repo.seedEvent(row());
    const app = createApp(deps);
    expect((await call(app, "GET", "/events/event_1/digest")).json).toMatchObject({ enabled: true, provider: { id: "local:mac-mini", status: "offline" } });
    const run = await call(app, "POST", "/events/event_1/digest/run");
    expect(run.status).toBe(503);
    expect(run.json.error.code).toBe("EVENT_AI_PROVIDER_OFFLINE");
    expect((await call(app, "POST", "/events/event_1/ask", { body: { question: "会場は？" } })).json.status).toBe("offline");
  });
  it("relay provider: no agent => offline; agent 503 => ProviderOffline", async () => {
    const stub = { fetch: async (url: string) => (url.endsWith("/status") ? Response.json({ agentOnline: false }) : new Response("{}", { status: 503 })) };
    const p = createRelayProvider(stub);
    expect(await p.status()).toBe("offline");
    await expect(p.summarize({} as never)).rejects.toThrow(/offline/);
  });
});

describe("HTTP: enabled with the fake provider (demo / tests)", () => {
  it("manual run stores a cited digest; GET returns it; ask cites sources", async () => {
    const deps = makeDeps({ digest: digestDeps() });
    deps.repo.seedEvent(row());
    const app = createApp(deps);
    const run = await call(app, "POST", "/events/event_1/digest/run");
    expect(run.status).toBe(200);
    expect(run.json.ran).toBe(true);
    expect(run.json.digest.lines.length).toBeGreaterThan(0);
    expect(run.json.digest.lines.every((l: { link: string }) => l.link !== "")).toBe(true);
    expect(deps.audit.records.map((r) => r.action)).toContain("event.event.ai_digest_generated");
    const get = await call(app, "GET", "/events/event_1/digest");
    expect(get.json.digest.model).toBe("fake");
    const ask = await call(app, "POST", "/events/event_1/ask", { body: { question: "北陸ITカンファレンス の会場" } });
    expect(ask.json.status).toBe("answered");
    expect(ask.json.sources.length).toBeGreaterThan(0);
  });
  it("an empty or oversized question is a 400", async () => {
    const deps = makeDeps({ digest: digestDeps() });
    deps.repo.seedEvent(row());
    const app = createApp(deps);
    expect((await call(app, "POST", "/events/event_1/ask", { body: { question: " " } })).status).toBe(400);
    expect((await call(app, "POST", "/events/event_1/ask", { body: { question: "あ".repeat(501) } })).status).toBe(400);
  });
  it("「今すぐ要約」 needs event:admin (an 編集 role without it gets 403)", async () => {
    const deps = makeDeps({ digest: digestDeps(), ...fakeAuthz(EDITOR) });
    deps.repo.seedEvent(row());
    const res = await call(createApp(deps), "POST", "/events/event_1/digest/run");
    expect(res.status).toBe(403);
  });
  it("a provider that throws offline mid-run surfaces as 503, nothing stored", async () => {
    const flaky: LlmProvider = { ...createFakeProvider(), id: "flaky", summarize: async () => { throw new (await import("../src/digest/types")).ProviderOfflineError(); } };
    const digest = digestDeps({ provider: flaky });
    const deps = makeDeps({ digest });
    deps.repo.seedEvent(row());
    expect((await call(createApp(deps), "POST", "/events/event_1/digest/run")).status).toBe(503);
    expect(digest.repo.digests.size).toBe(0);
  });
});

describe("schedule (DO alarm, no Cron)", () => {
  it("daily at 07:00 JST", () => {
    const now = Date.parse("2026-08-09T00:00:00.000Z"); // 09:00 JST
    expect(new Date(nextDigestRunAt(now, null)).toISOString()).toBe("2026-08-09T22:00:00.000Z");
    const early = Date.parse("2026-08-08T20:00:00.000Z"); // 05:00 JST
    expect(new Date(nextDigestRunAt(early, null)).toISOString()).toBe("2026-08-08T22:00:00.000Z");
  });
  it("every 3 hours in the final week before the event", () => {
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    expect(nextDigestRunAt(now, Date.parse("2026-09-13T00:00:00.000Z")) - now).toBe(FINAL_WEEK_INTERVAL_MS);
    expect(nextDigestRunAt(now, Date.parse("2026-10-13T00:00:00.000Z")) - now).not.toBe(FINAL_WEEK_INTERVAL_MS);
  });
});

describe("Mac mini agent gate", () => {
  const req = (auth?: string) => new Request("https://x/agent/event-digest/ws", { headers: auth ? { Authorization: auth } : {} });
  it("refused while the flag is OFF, even with the right secret", () => {
    expect(agentUpgradeAllowed(req("Bearer s3cret"), { DIGEST_AGENT_SECRET: "s3cret" } as never)).toBe(false);
  });
  it("enabled: needs the exact bearer secret; an unset secret refuses everyone", () => {
    const env = { EVENT_AI_DIGEST_ENABLED: "1", DIGEST_AGENT_SECRET: "s3cret" } as never;
    expect(agentUpgradeAllowed(req("Bearer s3cret"), env)).toBe(true);
    expect(agentUpgradeAllowed(req("Bearer wrong"), env)).toBe(false);
    expect(agentUpgradeAllowed(req(), env)).toBe(false);
    expect(agentUpgradeAllowed(req("Bearer "), { EVENT_AI_DIGEST_ENABLED: "1" } as never)).toBe(false);
    expect(secretEquals("", "")).toBe(false);
  });
  it("parseAgentFrame accepts only well-formed res frames", () => {
    expect(parseAgentFrame(JSON.stringify({ t: "res", id: "abc-1", body: { lines: [] } }))).toEqual({ id: "abc-1", ok: true, body: { lines: [] } });
    expect(parseAgentFrame(JSON.stringify({ t: "req", id: "a" }))).toBeNull();
    expect(parseAgentFrame("not json")).toBeNull();
    expect(parseAgentFrame(JSON.stringify({ t: "res", id: "../x" }))).toBeNull();
  });
});

describe("D1: migrations 0005/0006 + digest repo on real SQLite", () => {
  it("applies on top of 0001, stores venue/capacity, upserts digest + source hashes", async () => {
    const { d1, raw } = makeD1();
    for (const f of ["0001_init", "0005_event_venue_capacity", "0006_event_ai_digest", "0006_event_ai_digest"]) {
      raw.exec(readFileSync(new URL(`../../../infra/d1/migrations/event/${f}.sql`, import.meta.url), "utf8"));
    }
    const db = createDbClient(d1, { namespace: "event" });
    const { createD1EventRepo } = await import("../src/d1-repo");
    const events = createD1EventRepo(db);
    await events.createEvent(row());
    expect(await events.getEvent("event_1")).toMatchObject({ venue: "金沢工業大学", capacity: 300 });

    const repo = createD1DigestRepo(db);
    const d = { eventId: "event_1", lines: [{ text: "a", source: "tasks" as const, link: "/tasks/1" }], discrepancies: [], model: "fake", trigger: "manual" as const, generatedAt: NOW };
    await repo.saveDigest(d, NOW);
    await repo.saveDigest({ ...d, lines: [], generatedAt: "2026-08-10T00:00:00.000Z" }, "2026-08-10T00:00:00.000Z");
    expect(await repo.getDigest("event_1")).toMatchObject({ lines: [], generatedAt: "2026-08-10T00:00:00.000Z" });
    await repo.saveSourceHashes("event_1", { tasks: "h1", lp: "h2" }, NOW);
    await repo.saveSourceHashes("event_1", { tasks: "h3" }, NOW);
    expect(await repo.getSourceHashes("event_1")).toEqual({ tasks: "h3", lp: "h2" });
  });
});
