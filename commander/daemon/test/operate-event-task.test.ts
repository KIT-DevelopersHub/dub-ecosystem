// Event and task writes against an in-memory fake api-gateway shaped like event-service /
// task-service: each write previews, executes and is read back (done), a read-back that
// disagrees is reported as unverified, and the dependency replace is accepted as 検証不能.
import { OperateExecutor } from "../src/operate/executor.ts";
import { GatewayClient } from "../src/operate/gateway.ts";
import { parsePlan } from "../src/operate/plan.ts";

type Row = Record<string, unknown> & { id: string; version: number };

/** `drift` = fields the fake silently stores differently from what was sent. */
function fakeGateway(drift: Record<string, unknown> = {}) {
  const events = new Map<string, Row>([["ev1", { id: "ev1", title: "LT会", description: null, phase: "planning", startsAt: null, endsAt: null, version: 2 }]]);
  const actions = new Map<string, Row>([["ac1", { id: "ac1", eventId: "ev1", kind: "todo", title: "会場予約", sortOrder: 1024, version: 1 }]]);
  const tasks = new Map<string, Row>([["t1", { id: "t1", eventId: "ev1", title: "受付", description: null, status: "todo", priority: "medium", assigneeId: null, teamId: null, parentTaskId: null, wbs: null, startAt: null, dueAt: null, origin: "internal", version: 1 }]]);
  const docs = new Map<string, { data: unknown; version: number }>();
  const attachments: Record<string, unknown>[] = [];
  let seq = 0;

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    const store = (m: Map<string, Row>, r: Row) => (m.set(r.id, { ...r, ...drift }), reply(201, r));
    const patch = (m: Map<string, Row>, id: string) => {
      const r = m.get(id);
      if (!r) return reply(404, {});
      if (r.version !== body.version) return reply(409, { error: { code: "version_conflict" } });
      const { version: _v, ...rest } = body;
      const next = { ...r, ...rest, version: r.version + 1 };
      m.set(id, { ...next, ...drift });
      return reply(200, next);
    };

    if (method === "POST" && path === "/events") return store(events, { id: `ev${++seq + 1}`, description: null, startsAt: null, endsAt: null, ...body, phase: "planning", version: 1 });
    let m = path.match(/^\/events\/([^/]+)$/);
    if (m) return method === "GET" ? (events.has(m[1]!) ? reply(200, events.get(m[1]!)) : reply(404, {})) : patch(events, m[1]!);
    m = path.match(/^\/events\/([^/]+)\/(details|section-layout|page-layout)$/);
    if (m) {
      const k = `${m[1]}/${m[2]}`;
      const cur = docs.get(k) ?? { data: {}, version: 0 };
      if (method === "GET") return reply(200, { eventId: m[1], ...cur });
      if (body.version !== cur.version) return reply(409, { error: { code: "version_conflict" } });
      const next = { data: body.data, version: cur.version + 1 };
      docs.set(k, { ...next, ...drift });
      return reply(200, { eventId: m[1], ...next });
    }
    m = path.match(/^\/events\/([^/]+)\/actions$/);
    if (m && method === "POST") return store(actions, { id: `ac${++seq + 1}`, eventId: m[1]!, sortOrder: 2048, ...body, version: 1 });
    m = path.match(/^\/actions\/([^/]+)$/);
    if (m) return method === "GET" ? (actions.has(m[1]!) ? reply(200, actions.get(m[1]!)) : reply(404, {})) : patch(actions, m[1]!);
    if (method === "POST" && path === "/tasks") {
      return store(tasks, { id: `t${++seq + 1}`, eventId: null, description: null, status: "todo", priority: "medium", assigneeId: null, teamId: null, parentTaskId: null, wbs: null, startAt: null, dueAt: null, ...body, version: 1 });
    }
    m = path.match(/^\/tasks\/([^/]+)$/);
    if (m) return method === "GET" ? (tasks.has(m[1]!) ? reply(200, tasks.get(m[1]!)) : reply(404, {})) : patch(tasks, m[1]!);
    m = path.match(/^\/tasks\/([^/]+)\/dependencies$/);
    if (m && method === "PUT") return reply(200, { taskId: m[1], dependsOnIds: body.dependsOnIds });
    m = path.match(/^\/tasks\/([^/]+)\/attachments$/);
    if (m) {
      if (method === "GET") return reply(200, { items: attachments.filter((a) => a.taskId === m![1]) });
      const a = { id: `tatt${++seq}`, taskId: m[1], fileId: null, mimeType: null, sizeBytes: null, ...body };
      attachments.push({ ...a, ...drift });
      return reply(201, a);
    }
    return reply(404, { error: { code: "not_found" } });
  }) as typeof fetch;

  return new OperateExecutor(new GatewayClient({ baseUrl: "https://dub-api-gateway-staging.example.dev", token: "t" }, fetchImpl), { append() {} });
}

async function run(exec: OperateExecutor, steps: unknown[]) {
  const p = parsePlan({ summary: "テスト", steps });
  if (!p.ok) throw new Error(p.errors.join());
  const preview = await exec.preview(p.plan);
  expect(preview.blockers).toEqual([]);
  return { preview, result: await exec.execute(preview.previewId) };
}

const WRITES: [string, unknown[]][] = [
  ["events.create", [{ id: "c", op: "events.create", body: { title: "新歓", description: "春の新歓", startsAt: "2027-04-10T09:00:00Z" } }]],
  ["events.update", [{ id: "u", op: "events.update", params: { id: "ev1" }, body: { title: "LT会 春", version: 2 } }]],
  [
    "events.details.save",
    [
      { id: "g", op: "events.details.get", params: { id: "ev1" } },
      { id: "s", op: "events.details.save", params: { id: "ev1" }, body: { data: { venue: "大講義室", schedule: [] }, version: "{{g.version}}" } },
    ],
  ],
  ["events.sectionLayout.save", [{ id: "s", op: "events.sectionLayout.save", params: { id: "ev1" }, body: { data: { order: ["links", "overview"], hidden: [] }, version: 0 } }]],
  ["events.pageLayout.save", [{ id: "s", op: "events.pageLayout.save", params: { id: "ev1" }, body: { data: { version: 1, blocks: [{ type: "text" }], updatedAt: "" }, version: 0 }}]],
  ["events.actions.create", [{ id: "c", op: "events.actions.create", params: { id: "ev1" }, body: { kind: "todo", title: "備品確認" } }]],
  ["actions.update", [{ id: "u", op: "actions.update", params: { id: "ac1" }, body: { title: "会場予約（確定）", version: 1 } }]],
  ["tasks.create", [{ id: "c", op: "tasks.create", body: { title: "受付表を作る", eventId: "ev1", priority: "high", dueAt: "2027-04-01T00:00:00.000Z" } }]],
  [
    "tasks.update",
    [
      { id: "g", op: "tasks.get", params: { id: "t1" } },
      { id: "u", op: "tasks.update", params: { id: "t1" }, body: { status: "in_progress", assigneeId: "u1", version: "{{g.version}}" } },
    ],
  ],
  ["tasks.attachments.add", [{ id: "a", op: "tasks.attachments.add", params: { id: "t1" }, body: { kind: "url", name: "会場図", url: "https://example.com/map" } }]],
];

describe("event / task writes", () => {
  it.each(WRITES)("%s is read back after the write (done)", async (op, steps) => {
    const { preview, result } = await run(fakeGateway(), steps);
    expect(preview.writes.map((w) => w.entryId)).toEqual([op]);
    expect(preview.requiresPhrase).toBe(false);
    expect(result).toMatchObject({ verdict: "done", results: [{ outcome: "ok" }] });
  });

  it("reports a create whose read-back differs as unverified", async () => {
    const { result } = await run(fakeGateway({ title: "別のタイトル" }), WRITES[0]![1]);
    expect(result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
  });

  it("reports a details save overwritten by someone else as unverified", async () => {
    const { result } = await run(fakeGateway({ version: 99 }), WRITES[2]![1]);
    expect(result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
  });

  it("accepts the dependency replace as 検証不能 (no read can confirm the set)", async () => {
    const { preview, result } = await run(fakeGateway(), [
      { id: "d", op: "tasks.dependencies.replace", params: { id: "t1" }, body: { dependsOnIds: ["t0"], version: 1 } },
    ]);
    expect(preview.writes[0]!.unverifiable).toMatch(/照合できない/);
    expect(result).toMatchObject({ verdict: "done", results: [{ outcome: "accepted" }] });
  });

  it("does not let a plan change the event phase or a task's origin", () => {
    const phase = parsePlan({ summary: "", steps: [{ id: "u", op: "events.update", params: { id: "ev1" }, body: { phase: "open", version: 2 } }] });
    expect(phase).toMatchObject({ ok: false, errors: ["手順1: 本文の「phase」は変更できません"] });
    const origin = parsePlan({ summary: "", steps: [{ id: "c", op: "tasks.create", body: { title: "x", origin: "github" } }] });
    expect(origin).toMatchObject({ ok: false, errors: ["手順1: 本文の「origin」は変更できません"] });
  });
});
