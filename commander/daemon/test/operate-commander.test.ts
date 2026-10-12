// Commander area: calls go to the local commander-service (operator token, no /api/v1),
// writes are read back through its board / feature reads, and a missing connection blocks.
import { OperateExecutor } from "../src/operate/executor.ts";
import { CommanderServiceClient, GatewayClient } from "../src/operate/gateway.ts";
import { parsePlan } from "../src/operate/plan.ts";
import { createOperateHandler } from "../src/operate/routes.ts";

const SERVICE = "http://127.0.0.1:8798";
const TOKEN = "op-token";

interface Feature { id: string; title: string; phase: string }
interface Task { id: string; featureId: string; title: string; status: string }

/** In-memory commander-service. `stale` = accept writes without applying them. */
function fakeService(opts: { stale?: boolean } = {}) {
  const features = new Map<string, Feature>([["feat_1", { id: "feat_1", title: "既存機能", phase: "demo_review" }]]);
  const tasks = new Map<string, Task>([["ctask_1", { id: "ctask_1", featureId: "feat_1", title: "既存機能", status: "todo" }]]);
  const calls: { url: string; method: string; token: string | undefined }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), method, token: headers["x-commander-token"] });
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (url.origin !== SERVICE) return reply(500, { error: "wrong_host" });
    if (headers["x-commander-token"] !== TOKEN) return reply(401, { error: "unauthorized" });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const p = url.pathname;
    if (method === "GET" && p === "/tasks") {
      return reply(200, {
        items: [...tasks.values()].map((t) => ({ taskId: t.id, featureId: t.featureId, title: t.title, taskStatus: t.status, featurePhase: features.get(t.featureId)!.phase })),
      });
    }
    if (method === "POST" && p === "/tasks") {
      const n = features.size + 1;
      const feature = { id: `feat_${n}`, title: body.title, phase: "demo_building" };
      const task = { id: `ctask_${n}`, featureId: feature.id, title: body.title, status: "todo" };
      if (!opts.stale) {
        features.set(feature.id, feature);
        tasks.set(task.id, task);
      }
      return reply(201, { feature, task });
    }
    const patch = p.match(/^\/tasks\/([^/]+)$/);
    if (method === "PATCH" && patch) {
      const t = tasks.get(patch[1]!);
      if (!t) return reply(404, { error: "task_not_found" });
      if (!opts.stale) t.status = body.status;
      return reply(200, { task: t });
    }
    const feat = p.match(/^\/features\/([^/]+)$/);
    if (method === "GET" && feat) {
      const f = features.get(feat[1]!);
      return f ? reply(200, { feature: f, allowedTransitions: [], transitions: [] }) : reply(404, { error: "feature_not_found" });
    }
    const tr = p.match(/^\/features\/([^/]+)\/transition$/);
    if (method === "POST" && tr) {
      const f = features.get(tr[1]!);
      if (!f) return reply(404, { error: "feature_not_found" });
      if (body.to === "staging_deployed" && body.approvedByUser !== true) return reply(403, { error: "approval_required" });
      const from = f.phase;
      if (!opts.stale) f.phase = body.to;
      return reply(200, { feature: f, transition: { fromPhase: from, toPhase: body.to } });
    }
    return reply(404, { error: "not_found" });
  }) as typeof fetch;
  return { fetchImpl, calls, features, tasks };
}

function executor(svc: ReturnType<typeof fakeService>, withCommander = true) {
  return new OperateExecutor(
    new GatewayClient({ baseUrl: "https://dub-api-gateway.example.dev", token: "bot" }, svc.fetchImpl),
    { append() {} },
    Date.now,
    { roles: [], users: [] },
    withCommander ? new CommanderServiceClient({ baseUrl: SERVICE, token: TOKEN }, svc.fetchImpl) : undefined,
  );
}

async function run(exec: OperateExecutor, steps: unknown[]) {
  const p = parsePlan({ summary: "Commander 操作", steps });
  if (!p.ok) throw new Error(p.errors.join());
  const preview = await exec.preview(p.plan);
  return { preview, result: preview.blockers.length ? null : await exec.execute(preview.previewId) };
}

describe("operate: commander area", () => {
  it("creates a task on commander-service and reads it back from the board", async () => {
    const svc = fakeService();
    const { preview, result } = await run(executor(svc), [{ id: "c", op: "commander.tasks.create", body: { title: "新しいタスク" } }]);
    expect(preview).toMatchObject({ environment: "ローカル", requiresPhrase: false, writes: [{ api: "commander", risk: "mid", reversible: false }] });
    expect(result).toMatchObject({ verdict: "done", results: [{ outcome: "ok" }] });
    // Straight to the service: no /api/v1, the operator token, never the gateway.
    expect(svc.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${SERVICE}/tasks`, `GET ${SERVICE}/tasks`]);
    expect(svc.calls.every((c) => c.token === TOKEN)).toBe(true);
  });

  it("archives a task by changing its status", async () => {
    const svc = fakeService();
    const { result } = await run(executor(svc), [{ id: "u", op: "commander.tasks.updateStatus", params: { id: "ctask_1" }, body: { status: "done" } }]);
    expect(result).toMatchObject({ verdict: "done" });
    expect(svc.tasks.get("ctask_1")!.status).toBe("done");
  });

  it("advances a phase only behind the confirmation phrase and re-reads the phase", async () => {
    const svc = fakeService();
    const { preview, result } = await run(executor(svc), [
      { id: "f", op: "commander.features.get", params: { id: "feat_1" } },
      { id: "t", op: "commander.features.transition", params: { id: "feat_1" }, body: { to: "staging_deployed", approvedByUser: true } },
    ]);
    expect(preview).toMatchObject({ requiresPhrase: true, writes: [{ risk: "high" }] });
    expect(preview.writes[0]!.calls[0]).toMatchObject({ method: "POST", path: "/features/feat_1/transition" });
    expect(result).toMatchObject({ verdict: "done", results: [{ outcome: "ok" }] });
    expect(svc.features.get("feat_1")!.phase).toBe("staging_deployed");
  });

  it("reports a phase that did not change on re-read as unverified", async () => {
    const svc = fakeService({ stale: true });
    const { result } = await run(executor(svc), [
      { id: "t", op: "commander.features.transition", params: { id: "feat_1" }, body: { to: "demo_rejected", note: "直す" } },
    ]);
    expect(result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
    expect(JSON.stringify(result)).toContain("フェーズ が期待した値になっていません");
  });

  it("reports a create the board does not show as unverified", async () => {
    const { result } = await run(executor(fakeService({ stale: true })), [{ id: "c", op: "commander.tasks.create", body: { title: "幻のタスク" } }]);
    expect(result).toMatchObject({ verdict: "failed", results: [{ outcome: "unverified" }] });
  });

  it("blocks commander steps when the commander-service connection is not configured", async () => {
    const svc = fakeService();
    const { preview, result } = await run(executor(svc, false), [{ id: "l", op: "commander.tasks.list" }]);
    expect(preview.blockers).toEqual([expect.stringContaining("Commander の接続先が未設定です")]);
    expect(result).toBeNull();
    expect(svc.calls).toEqual([]);
  });

  it("wires OperateConfig.commander into the /operate handler", async () => {
    const svc = fakeService();
    const handle = createOperateHandler(
      { baseUrl: "https://dub-api-gateway.example.dev", token: "bot", auditLogPath: "/dev/null", commander: { baseUrl: SERVICE, token: TOKEN } },
      { fetch: svc.fetchImpl, audit: { append() {} } },
    );
    const plan = { summary: "読む", steps: [{ id: "l", op: "commander.tasks.list" }] };
    const res = await handle("POST", "/operate/preview", JSON.stringify({ plan }));
    expect(res).toMatchObject({ status: 200, body: { blockers: [], reads: [{ ok: true, count: 1 }] } });
    expect(svc.calls[0]).toMatchObject({ url: `${SERVICE}/tasks`, token: TOKEN });
  });
});
