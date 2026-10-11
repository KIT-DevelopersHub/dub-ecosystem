// Executor behaviour against an in-memory fake api-gateway: read->write binding, the
// placeholder/allow-list/cap gates, per-target outcomes, read-back verification, the
// single-use preview, and the audit trail.
import { OperateExecutor, MAX_WRITE_CALLS, type ExecutionResult, type Preview } from "../src/operate/executor.ts";
import { GatewayClient } from "../src/operate/gateway.ts";
import { parsePlan, type Plan } from "../src/operate/plan.ts";
import { createOperateHandler } from "../src/operate/routes.ts";

interface FakeOpts {
  ignorePatch?: boolean;
  /** Apply the PATCH but answer 504 (gateway timed out after the upstream wrote). */
  patchTimesOut?: "applied" | "lost";
  takenLocalParts?: string[];
  users?: number;
}

function fakeGateway(opts: FakeOpts = {}) {
  const events = [
    { id: "ev1", title: "北陸ITカンファレンス2027", description: "旧概要", version: 3 },
    { id: "ev2", title: "LT会", description: "x", version: 1 },
  ];
  const issued = [{ id: "r1", localPart: "taken", address: "taken@developershub.jp", enabled: true }];
  for (const lp of opts.takenLocalParts ?? []) issued.push({ id: `r-${lp}`, localPart: lp, address: `${lp}@developershub.jp`, enabled: true });
  const users = Array.from({ length: opts.users ?? 3 }, (_, i) => ({ id: `u${i}`, email: `user${i}@developershub.jp`, displayName: `ユーザー${i}` }));
  users.push({ id: "uT", email: "taken@developershub.jp", displayName: "発行済み" });
  const notifs = [{ id: "n1", title: "デプロイ完了", publishedBroadcastId: "b1" }];
  const calls: string[] = [];
  let tokenValid = true;

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v1/, "");
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (path === "/auth/password/login") {
      tokenValid = true;
      return reply(200, { token: "fresh" });
    }
    if (!tokenValid) return reply(401, { error: { code: "unauthorized" } });
    if (method === "GET" && path === "/events") return reply(200, { items: events.map(({ id, title }) => ({ id, title })) });
    const ev = path.match(/^\/events\/([^/]+)$/);
    if (ev) {
      const e = events.find((x) => x.id === ev[1]);
      if (!e) return reply(404, { error: { code: "not_found" } });
      if (method === "GET") return reply(200, e);
      if (body.version !== e.version) return reply(409, { error: { code: "version_conflict" } });
      if (opts.patchTimesOut === "lost") return reply(504, { error: { code: "UPSTREAM_TIMEOUT" } });
      if (!opts.ignorePatch) Object.assign(e, body, { version: e.version + 1 });
      if (opts.patchTimesOut === "applied") return reply(504, { error: { code: "UPSTREAM_TIMEOUT" } });
      return reply(200, e);
    }
    if (path === "/identity/users") return reply(200, { items: users });
    if (path === "/mail/admin/email-routing/issued-addresses") {
      if (method === "GET") return reply(200, { items: issued, nextCursor: null });
      if (issued.some((a) => a.localPart === body.localPart)) return reply(409, { error: { code: "conflict" } });
      const a = { id: `r${issued.length + 1}`, localPart: body.localPart, address: `${body.localPart}@developershub.jp`, enabled: true };
      issued.push(a);
      return reply(201, a);
    }
    if (path === "/notifications/manage") return reply(200, { items: notifs });
    const un = path.match(/^\/notifications\/manage\/([^/]+)\/unpublish$/);
    if (un) {
      const n = notifs.find((x) => x.id === un[1]);
      if (!n) return reply(404, {});
      n.publishedBroadcastId = null as unknown as string;
      return reply(202, { notificationId: n.id, retracted: true });
    }
    return reply(404, { error: { code: "no_route" } });
  }) as typeof fetch;

  return { fetchImpl, calls, events, issued, expireToken: () => (tokenValid = false) };
}

function setup(opts: FakeOpts = {}, gatewayCfg: { token?: string; email?: string; password?: string } = { token: "t" }) {
  const gw = fakeGateway(opts);
  const audit: Record<string, unknown>[] = [];
  const exec = new OperateExecutor(
    new GatewayClient({ baseUrl: "https://dub-api-gateway-staging.example.dev", ...gatewayCfg }, gw.fetchImpl),
    { append: (r) => audit.push(r) },
  );
  return { gw, audit, exec };
}

function plan(raw: unknown): Plan {
  const p = parsePlan(raw);
  if (!p.ok) throw new Error(p.errors.join("\n"));
  return p.plan;
}

const writes = (calls: string[]) => calls.filter((c) => !c.startsWith("GET"));

const EVENT_PLAN = {
  summary: "北陸ITカンファレンス2027 の概要を差し替える",
  steps: [
    { id: "list", op: "events.list" },
    { id: "ev", op: "events.get", forEach: "list.items", where: [{ field: "title", op: "contains", value: "北陸IT" }], params: { id: "{{item.id}}" } },
    { id: "upd", op: "events.update", forEach: "ev", params: { id: "{{item.id}}" }, body: { description: "新しい概要", version: "{{item.version}}" }, label: "{{item.title}}" },
  ],
};

describe("OperateExecutor — preview", () => {
  it("runs reads, binds their results into the write, and writes nothing", async () => {
    const { exec, gw } = setup();
    const p = await exec.preview(plan(EVENT_PLAN));
    expect(p.blockers).toEqual([]);
    expect(p.environment).toBe("staging");
    expect(p.reads.map((r) => [r.stepId, r.ok, r.count])).toEqual([["list", true, 2], ["ev", true, 1]]);
    const call = p.writes[0]!.calls[0]!;
    expect(call).toMatchObject({ method: "PATCH", path: "/events/ev1", target: "北陸ITカンファレンス2027", before: { description: "旧概要" } });
    expect(call.body).toEqual({ description: "新しい概要", version: 3 });
    expect(writes(gw.calls)).toEqual([]);
  });

  it("blocks a literal placeholder before any write could be sent", async () => {
    const { exec, gw } = setup();
    const p = await exec.preview(plan({ summary: "", steps: [{ id: "u", op: "events.update", params: { id: "<EVENT_ID>" }, body: { description: "x", version: 1 } }] }));
    expect(p.blockers.join()).toMatch(/params\.id が決まっていません/);
    expect(gw.calls).toEqual([]);
    expect(await exec.execute(p.previewId)).toHaveProperty("error");
  });

  it("blocks a reference the reads could not fill", async () => {
    const { exec } = setup();
    const p = await exec.preview(plan({ summary: "", steps: [{ id: "list", op: "events.list" }, { id: "u", op: "events.update", params: { id: "{{list.items[0].id}}" }, body: { description: "x", version: "{{list.items[0].version}}" } }] }));
    expect(p.blockers.join()).toMatch(/body\.version/);
  });

  it("caps writes per execution", async () => {
    const { exec } = setup({ users: MAX_WRITE_CALLS + 5 });
    const p = await exec.preview(plan({ summary: "", steps: [{ id: "users", op: "users.list" }, { id: "w", op: "mail.issued.create", forEach: "users.items", body: { localPart: "{{item.email|localPart}}" } }] }));
    expect(p.blockers.join()).toMatch(/上限/);
  });

  it("reports zero matching targets instead of silently doing nothing", async () => {
    const { exec } = setup();
    const p = await exec.preview(plan({ ...EVENT_PLAN, steps: EVENT_PLAN.steps.map((s) => (s.id === "ev" ? { ...s, where: [{ field: "title", op: "eq", value: "存在しない" }] } : s)) }));
    expect(p.blockers).toEqual(["条件に合う対象が0件でした。何も変更しません"]);
  });
});

describe("parsePlan — allow-list", () => {
  it("rejects routes outside the catalog and fields the entry does not allow", () => {
    const r = parsePlan({ steps: [{ id: "a", op: "d1.execute" }, { id: "b", op: "events.update", body: { phase: "done", version: 1 } }] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join("\n")).toMatch(/許可された操作にありません[\s\S]*「phase」は変更できません/);
  });
});

describe("OperateExecutor — execute", () => {
  async function run(exec: OperateExecutor, raw: unknown, skip?: string[]) {
    const p: Preview = await exec.preview(plan(raw));
    expect(p.blockers).toEqual([]);
    return (await exec.execute(p.previewId, skip)) as ExecutionResult;
  }

  it("writes, reads back, and says 反映できました; a preview runs only once", async () => {
    const { exec, gw, audit } = setup();
    const p = await exec.preview(plan(EVENT_PLAN));
    const r = (await exec.execute(p.previewId)) as ExecutionResult;
    expect(r.verdict).toBe("done");
    expect(r.headline).toMatch(/^反映できました/);
    expect(gw.events[0]!.description).toBe("新しい概要");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ verdict: "done", environment: "staging", calls: [{ method: "PATCH", path: "/events/ev1", outcome: "ok" }] });
    expect(await exec.execute(p.previewId)).toHaveProperty("error");
  });

  it("splits a partial failure into per-target outcomes", async () => {
    const { exec } = setup({ users: 2 });
    const r = await run(exec, {
      summary: "メールが無い人に発行",
      steps: [
        { id: "users", op: "users.list" },
        { id: "w", op: "mail.issued.create", forEach: "users.items", body: { localPart: "{{item.email|localPart}}" }, label: "{{item.displayName}}" },
      ],
    });
    expect(r.verdict).toBe("partial");
    expect(r.results.map((x) => [x.target, x.outcome])).toEqual([["ユーザー0", "ok"], ["ユーザー1", "ok"], ["発行済み", "failed"]]);
    expect(r.results[2]!.message).toMatch(/競合/);
  });

  it("issues only to people without an address (notIn against an earlier read)", async () => {
    const { exec, gw } = setup({ users: 1 });
    const r = await run(exec, {
      summary: "",
      steps: [
        { id: "users", op: "users.list" },
        { id: "issued", op: "mail.issued.list" },
        { id: "w", op: "mail.issued.create", forEach: "users.items", where: [{ field: "email", op: "notIn", value: "{{issued.items[*].address}}" }], body: { localPart: "{{item.email|localPart}}" } },
      ],
    });
    expect(r.verdict).toBe("done");
    expect(writes(gw.calls)).toEqual(["POST /mail/admin/email-routing/issued-addresses"]);
  });

  it("does not call skipped targets (対象を減らす)", async () => {
    const { exec, gw } = setup({ users: 2 });
    const r = await run(exec, { summary: "", steps: [{ id: "users", op: "users.list" }, { id: "w", op: "mail.issued.create", forEach: "users.items", where: [{ field: "id", op: "ne", value: "uT" }], body: { localPart: "{{item.email|localPart}}" } }] }, ["w#2"]);
    expect(r.results.map((x) => x.outcome)).toEqual(["ok", "skipped"]);
    expect(writes(gw.calls)).toHaveLength(1);
  });

  it("calls an accepted-but-not-applied write できませんでした", async () => {
    const { exec } = setup({ ignorePatch: true });
    const r = await run(exec, EVENT_PLAN);
    expect(r.verdict).toBe("failed");
    expect(r.results[0]).toMatchObject({ outcome: "unverified" });
    expect(r.results[0]!.message).toMatch(/概要 が期待した値/);
  });

  it("lets the read-back decide after a timeout: applied => 反映できた, lost => できなかった", async () => {
    const applied = await run(setup({ patchTimesOut: "applied" }).exec, EVENT_PLAN);
    expect(applied.verdict).toBe("done");
    expect(applied.results[0]!.message).toMatch(/読み直すと反映されていました/);
    const lost = await run(setup({ patchTimesOut: "lost" }).exec, EVENT_PLAN);
    expect(lost.verdict).toBe("failed");
    expect(lost.results[0]).toMatchObject({ outcome: "failed" });
    expect(lost.results[0]!.message).toMatch(/504 UPSTREAM_TIMEOUT.*読み直しても反映は確認できませんでした/);
  });

  it("verifies a notification delete (unpublish) by re-reading the list", async () => {
    const { exec } = setup();
    const r = await run(exec, { summary: "", steps: [{ id: "n", op: "notifications.manage.list" }, { id: "d", op: "notifications.unpublish", forEach: "n.items", where: [{ field: "title", op: "eq", value: "デプロイ完了" }], params: { id: "{{item.id}}" } }] });
    expect(r.verdict).toBe("done");
  });
});

describe("GatewayClient", () => {
  it("logs the bot in and re-logs once on 401", async () => {
    const { exec, gw } = setup({}, { email: "bot@developershub.jp", password: "pw" });
    await exec.preview(plan({ summary: "", steps: [{ id: "l", op: "events.list" }] }));
    gw.expireToken();
    const p = await exec.preview(plan({ summary: "", steps: [{ id: "l", op: "events.list" }] }));
    expect(p.reads[0]!.ok).toBe(true);
    expect(gw.calls.filter((c) => c.endsWith("/auth/password/login"))).toHaveLength(2);
  });
});

describe("operate routes", () => {
  it("serves the catalog but refuses to run when no API is configured", async () => {
    const handle = createOperateHandler(undefined);
    const cat = await handle("GET", "/operate/catalog", "");
    expect(cat.status).toBe(200);
    expect((cat.body as { configured: boolean }).configured).toBe(false);
    expect((await handle("POST", "/operate/preview", "{}")).status).toBe(503);
  });

  it("returns Japanese blockers for an invalid plan", async () => {
    const gw = fakeGateway();
    const handle = createOperateHandler({ baseUrl: "http://x", token: "t", auditLogPath: "/dev/null" }, { fetch: gw.fetchImpl, audit: { append() {} } });
    const r = await handle("POST", "/operate/preview", JSON.stringify({ plan: { steps: [{ id: "a", op: "sql" }] } }));
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/許可された操作にありません/);
  });
});
