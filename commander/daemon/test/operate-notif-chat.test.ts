// 通知・チャットの書き込みエントリを、本物のカタログで fake api-gateway に対して
// preview -> execute -> 読み直しまで通す。
import { OperateExecutor } from "../src/operate/executor.ts";
import { GatewayClient } from "../src/operate/gateway.ts";
import { parsePlan } from "../src/operate/plan.ts";

interface Opts {
  /** The gateway answers OK but drops the write (read-back must catch it). */
  dropWrites?: boolean;
}

function fakeGateway(opts: Opts = {}) {
  const inbox = [{ id: "i1", type: "release", title: "既存のお知らせ", body: "旧本文" }];
  const channels = new Map<string, Record<string, unknown>>([
    ["c1", { id: "c1", type: "topic", visibility: "public", name: "general", topic: null, eventId: null, archivedAt: null, version: 2 }],
  ]);
  const members = new Map<string, { userId: string; role: string }[]>([["c1", [{ userId: "bot", role: "admin" }, { userId: "u1", role: "member" }]]]);
  const messages = [{ id: "m1", channelId: "c1", threadRootId: null, authorId: "bot", body: "こんにちは", version: 1, deletedAt: null }];
  const pins = new Map<string, string[]>([["c1", []]]);
  const reactions = new Map<string, Record<string, string[]>>();
  const calls: string[] = [];
  let seq = 0;

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v1/, "");
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    const drop = opts.dropWrites;

    if (path === "/notifications/inbox") return reply(200, { items: inbox, nextCursor: null });
    if (method === "POST" && path === "/notifications/release") {
      const existing = inbox.find((i) => i.title === body.title);
      if (existing) return reply(202, { notificationId: "n-old", deduplicated: true });
      if (!drop) inbox.unshift({ id: `i${++seq + 1}`, type: "release", title: body.title, body: body.body });
      return reply(202, { notificationId: `n${seq}`, deduplicated: false });
    }

    if (method === "POST" && path === "/chat/channels") {
      const ch = { id: `c${channels.size + 1}`, topic: null, eventId: null, archivedAt: null, version: 1, ...body, memberIds: undefined };
      if (!drop) channels.set(ch.id, ch);
      return reply(201, ch);
    }
    const ch = path.match(/^\/chat\/channels\/([^/]+)$/);
    if (ch) {
      const c = channels.get(ch[1]!);
      if (!c) return reply(404, {});
      if (method === "GET") return reply(200, { channel: c, membership: null });
      if (body.version !== c.version) return reply(409, {});
      const next: Record<string, unknown> = { ...c, version: (c.version as number) + 1 };
      if (body.name !== undefined) next.name = body.name;
      if (body.topic !== undefined) next.topic = body.topic;
      if (body.archived !== undefined) next.archivedAt = body.archived ? "2026-10-12T00:00:00Z" : null;
      if (!drop) channels.set(c.id as string, next);
      return reply(200, next);
    }
    const mem = path.match(/^\/chat\/channels\/([^/]+)\/members(?:\/([^/]+))?$/);
    if (mem) {
      const list = members.get(mem[1]!) ?? [];
      if (method === "GET") return reply(200, list);
      if (method === "POST" && !drop && !list.some((m) => m.userId === body.userId)) list.push({ userId: body.userId, role: body.role ?? "member" });
      if (method === "DELETE" && !drop) members.set(mem[1]!, list.filter((m) => m.userId !== mem[2]));
      return new Response(null, { status: 204 });
    }
    const pin = path.match(/^\/chat\/channels\/([^/]+)\/pins$/);
    if (pin) {
      const ids = pins.get(pin[1]!) ?? [];
      const list = (xs: string[]) => messages.filter((m) => xs.includes(m.id));
      if (method === "GET") return reply(200, list(ids));
      const next = ids.includes(body.messageId) ? ids.filter((x) => x !== body.messageId) : [...ids, body.messageId];
      if (!drop) pins.set(pin[1]!, next);
      return reply(200, list(next));
    }
    const react = path.match(/^\/chat\/messages\/([^/]+)\/reactions$/);
    if (react && method === "POST") {
      const set = { ...(reactions.get(react[1]!) ?? {}) };
      const users = set[body.emoji] ?? [];
      set[body.emoji] = users.includes("bot") ? users.filter((u) => u !== "bot") : [...users, "bot"];
      if (set[body.emoji]!.length === 0) delete set[body.emoji];
      if (!drop) reactions.set(react[1]!, set);
      return reply(200, { messageId: react[1], reactions: set });
    }
    if (method === "GET" && path === "/chat/messages") {
      const root = url.searchParams.get("threadRootId") || null;
      return reply(200, { items: messages.filter((m) => m.channelId === url.searchParams.get("channelId") && m.threadRootId === root), nextCursor: null });
    }
    if (method === "POST" && path === "/chat/messages") {
      const m = { id: `m${messages.length + 1}`, channelId: body.channelId, threadRootId: body.threadRootId ?? null, authorId: "bot", body: body.body, version: 1, deletedAt: null };
      if (!drop) messages.push(m);
      return reply(201, m);
    }
    const msg = path.match(/^\/chat\/messages\/([^/]+)$/);
    if (msg) {
      const i = messages.findIndex((m) => m.id === msg[1]);
      if (i < 0) return reply(404, {});
      if (method === "DELETE") {
        messages.splice(i, 1);
        return reply(200, { mode: "hard", message: null });
      }
      const next = { ...messages[i]!, body: body.body, version: messages[i]!.version + 1 };
      if (!drop) messages[i] = next;
      return reply(200, next);
    }
    return reply(404, { error: { code: "no_route" } });
  }) as typeof fetch;

  return { fetchImpl, calls, inbox, channels, members, messages, pins, reactions };
}

function setup(opts: Opts = {}) {
  const gw = fakeGateway(opts);
  const exec = new OperateExecutor(new GatewayClient({ baseUrl: "https://dub-api-gateway-staging.example.dev", token: "t" }, gw.fetchImpl), { append() {} });
  return { gw, exec };
}

async function run(exec: OperateExecutor, step: Record<string, unknown>) {
  const p = parsePlan({ summary: "テスト", steps: [{ id: "w", ...step }] });
  if (!p.ok) throw new Error(p.errors.join());
  const preview = await exec.preview(p.plan);
  expect(preview.blockers).toEqual([]);
  return { preview, result: await exec.execute(preview.previewId) };
}

describe("通知の書き込み", () => {
  it("新規送信はボットの受信箱で件名と本文を読み直す", async () => {
    const { gw, exec } = setup();
    const { preview, result } = await run(exec, { op: "notifications.release", body: { title: "新機能のお知らせ", body: "チャットに検索が付きました" } });
    expect(preview.requiresPhrase).toBe(true);
    expect(preview.writes[0]).toMatchObject({ reversible: false, risk: "high" });
    expect(result).toMatchObject({ verdict: "done", results: [{ outcome: "ok" }] });
    expect(gw.calls).toContain("GET /notifications/inbox");
  });

  it("同じ件名の再送は既存が返り本文が変わらないので未確認になる", async () => {
    const { exec } = setup();
    const { result } = await run(exec, { op: "notifications.release", body: { title: "既存のお知らせ", body: "新しい本文" } });
    expect(result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
  });
});

describe("チャットの書き込み", () => {
  it("チャンネル作成は応答の id で読み直す", async () => {
    const { exec } = setup();
    const { result } = await run(exec, { op: "chat.channels.create", body: { type: "topic", visibility: "private", name: "運営会議", memberIds: ["u1"] } });
    expect(result).toMatchObject({ verdict: "done" });
  });

  it("チャンネル更新は送った項目だけを照合し、アーカイブは応答と突き合わせる", async () => {
    const { exec } = setup();
    expect((await run(exec, { op: "chat.channels.update", params: { id: "c1" }, body: { version: 2, archived: true } })).result).toMatchObject({ verdict: "done" });
    expect((await run(exec, { op: "chat.channels.update", params: { id: "c1" }, body: { version: 3, name: "雑談" } })).result).toMatchObject({ verdict: "done" });
  });

  it("メンバー追加は一覧に居ることを、削除は居ないことを読み直す", async () => {
    const { gw, exec } = setup();
    expect((await run(exec, { op: "chat.members.add", params: { id: "c1" }, body: { userId: "u2", role: "admin" } })).result).toMatchObject({ verdict: "done" });
    const removed = await run(exec, { op: "chat.members.remove", params: { id: "c1", userId: "u1" } });
    expect(removed.preview.requiresPhrase).toBe(true);
    expect(removed.result).toMatchObject({ verdict: "done" });
    expect(gw.members.get("c1")!.map((m) => m.userId)).toEqual(["bot", "u2"]);
  });

  it("削除が反映されずメンバーが残っていれば未確認になる", async () => {
    const { exec } = setup({ dropWrites: true });
    const { result } = await run(exec, { op: "chat.members.remove", params: { id: "c1", userId: "u1" } });
    expect(result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
    expect(JSON.stringify(result)).toContain("一覧に残っています");
  });

  it("メッセージ送信と編集はチャンネルの一覧で本文を読み直す", async () => {
    const { exec } = setup();
    expect((await run(exec, { op: "chat.messages.post", body: { channelId: "c1", body: "お知らせです" } })).result).toMatchObject({ verdict: "done" });
    expect((await run(exec, { op: "chat.messages.post", body: { channelId: "c1", body: "返信", threadRootId: "m1" } })).result).toMatchObject({ verdict: "done" });
    expect((await run(exec, { op: "chat.messages.edit", params: { id: "m1" }, body: { version: 1, body: "こんばんは" } })).result).toMatchObject({ verdict: "done" });
  });

  it("書き込みが落ちたら送信も編集も未確認になる", async () => {
    const { exec } = setup({ dropWrites: true });
    expect((await run(exec, { op: "chat.messages.post", body: { channelId: "c1", body: "お知らせです" } })).result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
    expect((await run(exec, { op: "chat.messages.edit", params: { id: "m1" }, body: { version: 1, body: "こんばんは" } })).result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
    expect((await run(exec, { op: "chat.channels.update", params: { id: "c1" }, body: { version: 2, archived: true } })).result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
  });

  it("ピン留めは切り替え後の一覧を読み直し、もう一度で外れる", async () => {
    const { gw, exec } = setup();
    const on = await run(exec, { op: "chat.pins.toggle", params: { id: "c1" }, body: { messageId: "m1" } });
    expect(on.preview.writes[0]).toMatchObject({ reversible: true, risk: "mid" });
    expect(on.result).toMatchObject({ verdict: "done", results: [{ outcome: "ok" }] });
    expect(gw.pins.get("c1")).toEqual(["m1"]);
    expect((await run(exec, { op: "chat.pins.toggle", params: { id: "c1" }, body: { messageId: "m1" } })).result).toMatchObject({ verdict: "done" });
    expect(gw.pins.get("c1")).toEqual([]);
    expect(gw.calls).toContain("GET /chat/channels/c1/pins");
  });

  it("ピン留めが反映されなければ未確認になる", async () => {
    const { exec } = setup({ dropWrites: true });
    const { result } = await run(exec, { op: "chat.pins.toggle", params: { id: "c1" }, body: { messageId: "m1" } });
    expect(result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
    expect(JSON.stringify(result)).toContain("ピン留めの一覧");
  });

  it("リアクションはボットの名前で切り替わり、検証不能の受付として報告する", async () => {
    const { gw, exec } = setup();
    const { preview, result } = await run(exec, { op: "chat.reactions.toggle", params: { id: "m1" }, body: { emoji: "👍" } });
    expect(preview.requiresPhrase).toBe(false);
    expect(preview.writes[0]!.unverifiable).toContain("確かめられない");
    expect(result).toMatchObject({ verdict: "done", results: [{ outcome: "accepted" }] });
    expect(gw.reactions.get("m1")).toEqual({ "👍": ["bot"] });
    await run(exec, { op: "chat.reactions.toggle", params: { id: "m1" }, body: { emoji: "👍" } });
    expect(gw.reactions.get("m1")).toEqual({});
  });

  it("メッセージ削除は確認フレーズ必須で、検証不能の受付として報告する", async () => {
    const { gw, exec } = setup();
    const { preview, result } = await run(exec, { op: "chat.messages.delete", params: { id: "m1" } });
    expect(preview.requiresPhrase).toBe(true);
    expect(preview.writes[0]!.unverifiable).toContain("確かめられない");
    expect(result).toMatchObject({ verdict: "done", results: [{ outcome: "accepted" }] });
    expect(gw.messages).toEqual([]);
  });
});
