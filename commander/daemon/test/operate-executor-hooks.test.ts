// Executor hooks the area entries build on, exercised with synthetic catalog entries:
// "$result.x" read-backs for creates, deny rules for protected ids, and 検証不能 writes.
import type { CatalogEntry } from "../src/operate/catalog-types.ts";

const EXTRA: CatalogEntry[] = [
  { id: "things.list", area: "event", method: "GET", path: "/things", service: "x", requires: { keys: [] }, kind: "read", reversible: true, risk: "low", description: "一覧", impact: "読み取りのみ。", query: ["tag"] },
  {
    id: "things.remove", area: "event", method: "DELETE", path: "/things/:id", service: "x", requires: { keys: [] }, kind: "delete", reversible: true, risk: "high",
    description: "削除", impact: "{count}件削除", query: ["tag"],
    verify: { read: "things.list", query: { tag: "$query.tag" }, findIn: "items", findBy: ["id", "$params.id"], present: false },
  },
  { id: "things.get", area: "event", method: "GET", path: "/things/:id", service: "x", requires: { keys: [] }, kind: "read", reversible: true, risk: "low", description: "取得", impact: "読み取りのみ。" },
  {
    id: "things.create", area: "event", method: "POST", path: "/things", service: "x", requires: { keys: [] }, kind: "write", reversible: true, risk: "mid",
    description: "作成", impact: "{count}件作成", body: { allowed: ["name"], required: ["name"] },
    verify: { read: "things.get", params: { id: "$result.id" }, expect: { name: "$body.name" } },
  },
  {
    id: "roles.edit", area: "role", method: "PATCH", path: "/roles/:id", service: "x", requires: { keys: [] }, kind: "write", reversible: true, risk: "high",
    description: "編集", impact: "{count}件編集", body: { allowed: ["name"], required: ["name"] },
    deny: [{ field: "params.id", set: "roles", reason: "オーナーのロールは編集できません" }],
    unverifiable: "読み直せる API が無い",
  },
];

vi.mock("../src/operate/catalog.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/operate/catalog.ts")>();
  return { ...real, findEntry: (id: string) => EXTRA.find((e) => e.id === id) ?? real.findEntry(id) };
});

const { OperateExecutor } = await import("../src/operate/executor.ts");
const { GatewayClient } = await import("../src/operate/gateway.ts");
const { parsePlan } = await import("../src/operate/plan.ts");

function setup(opts: { createdName?: string; status?: number; keep?: boolean } = {}) {
  const things = new Map<string, { id: string; name: string }>();
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (init?.method === "POST" && path === "/things") {
      const t = { id: `t${things.size + 1}`, name: opts.createdName ?? body.name };
      things.set(t.id, t);
      return reply(201, t);
    }
    const get = path.match(/^\/things\/(.+)$/);
    if (get) return things.has(get[1]!) ? reply(200, things.get(get[1]!)) : reply(404, {});
    if (init?.method === "PATCH") return reply(opts.status ?? 200, {});
    if (path === "/things") {
      const tag = new URL(String(input)).searchParams.get("tag");
      return reply(200, { items: tag === "x" ? [...things.values()] : [] });
    }
    if (init?.method === "DELETE") {
      if (!opts.keep) things.delete(path.split("/")[2]!);
      return new Response(null, { status: 204 });
    }
    return reply(404, {});
  }) as typeof fetch;
  return new OperateExecutor(
    new GatewayClient({ baseUrl: "https://dub-api-gateway-staging.example.dev", token: "t" }, fetchImpl),
    { append() {} },
    Date.now,
    { roles: ["role_sys_admin"], users: [] },
  );
}

async function run(exec: InstanceType<typeof OperateExecutor>, steps: unknown[]) {
  const p = parsePlan({ summary: "", steps });
  if (!p.ok) throw new Error(p.errors.join());
  const preview = await exec.preview(p.plan);
  return { preview, result: preview.blockers.length ? null : await exec.execute(preview.previewId) };
}

describe("executor hooks", () => {
  it("verifies a removal by the target being gone, reading with the write's own query", async () => {
    const steps = [{ id: "c", op: "things.create", body: { name: "a" } }, { id: "d", op: "things.remove", params: { id: "t1" }, query: { tag: "x" } }];
    expect((await run(setup(), steps)).result).toMatchObject({ verdict: "done" });
    expect((await run(setup({ keep: true }), steps)).result).toMatchObject({ results: [{ outcome: "ok" }, { outcome: "unverified" }] });
  });

  it("re-reads a create through the id its response returned", async () => {
    const ok = await run(setup(), [{ id: "c", op: "things.create", body: { name: "新規" } }]);
    expect(ok.result).toMatchObject({ verdict: "done" });
    const wrong = await run(setup({ createdName: "別物" }), [{ id: "c", op: "things.create", body: { name: "新規" } }]);
    expect(wrong.result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
  });

  it("blocks a plan that targets a protected id before approval", async () => {
    const { preview, result } = await run(setup(), [{ id: "e", op: "roles.edit", params: { id: "role_sys_admin" }, body: { name: "x" } }]);
    expect(preview.blockers).toEqual(["手順1: オーナーのロールは編集できません"]);
    expect(result).toBeNull();
  });

  it("reports an unverifiable write as accepted, not as confirmed", async () => {
    const { preview, result } = await run(setup(), [{ id: "e", op: "roles.edit", params: { id: "role_x" }, body: { name: "x" } }]);
    expect(preview.writes[0]!.unverifiable).toBe("読み直せる API が無い");
    expect(preview.requiresPhrase).toBe(true);
    expect(result).toMatchObject({ verdict: "done", headline: "反映できました（1件は検証不能で受付のみ確認）", results: [{ outcome: "accepted" }] });
    const failed = await run(setup({ status: 504 }), [{ id: "e", op: "roles.edit", params: { id: "role_x" }, body: { name: "x" } }]);
    expect(failed.result).toMatchObject({ verdict: "failed", results: [{ outcome: "failed" }] });
    expect(JSON.stringify(failed.result)).toContain("検証不能のため反映されたかは分かりません");
  });
});
