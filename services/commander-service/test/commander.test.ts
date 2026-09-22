import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { makeD1 } from "./d1";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { DB: makeD1().d1, ...overrides };
}

async function call(
  app: ReturnType<typeof createApp>,
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const req = new Request(`http://x${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await app.fetch(req, env as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (await res.json().catch(() => null)) as any;
  return { status: res.status, json };
}

describe("commander-service phase gate", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;

  beforeEach(() => {
    app = createApp();
    env = makeEnv();
  });

  it("creates a feature at demo_building", async () => {
    const r = await call(app, env, "POST", "/features", {
      title: "使用量ダッシュボード",
      ledgerRef: "Dub_フィーチャー台帳#usage",
    });
    expect(r.status).toBe(201);
    expect(r.json.feature.phase).toBe("demo_building");
    expect(r.json.feature.ledgerRef).toBe("Dub_フィーチャー台帳#usage");
  });

  it("advances a system edge without approval (demo_building -> demo_review)", async () => {
    const c = await call(app, env, "POST", "/features", { title: "F" });
    const id = c.json.feature.id;
    const r = await call(app, env, "POST", `/features/${id}/transition`, {
      to: "demo_review",
    });
    expect(r.status).toBe(200);
    expect(r.json.feature.phase).toBe("demo_review");
    expect(r.json.transition.actor).toBe("system");
    expect(r.json.transition.approvedByUser).toBe(false);
  });

  it("段飛ばし: demo_review -> prod_shipped is 409 and does NOT mutate", async () => {
    const c = await call(app, env, "POST", "/features", { title: "F" });
    const id = c.json.feature.id;
    await call(app, env, "POST", `/features/${id}/transition`, { to: "demo_review" });

    const r = await call(app, env, "POST", `/features/${id}/transition`, {
      to: "prod_shipped",
      approvedByUser: true,
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("illegal_transition");

    const after = await call(app, env, "GET", `/features/${id}`);
    expect(after.json.feature.phase).toBe("demo_review"); // unchanged
  });

  it("自己承認: approval-required edge without approvedByUser is 403 and does NOT mutate", async () => {
    const c = await call(app, env, "POST", "/features", { title: "F" });
    const id = c.json.feature.id;
    await call(app, env, "POST", `/features/${id}/transition`, { to: "demo_review" });

    const r = await call(app, env, "POST", `/features/${id}/transition`, {
      to: "staging_deployed",
    });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("approval_required");

    const after = await call(app, env, "GET", `/features/${id}`);
    expect(after.json.feature.phase).toBe("demo_review"); // unchanged
  });

  it("承認あり: demo_review -> staging_deployed with approvedByUser records actor=user", async () => {
    const c = await call(app, env, "POST", "/features", { title: "F" });
    const id = c.json.feature.id;
    await call(app, env, "POST", `/features/${id}/transition`, { to: "demo_review" });

    const r = await call(app, env, "POST", `/features/${id}/transition`, {
      to: "staging_deployed",
      approvedByUser: true,
      note: "demo確認OK",
    });
    expect(r.status).toBe(200);
    expect(r.json.feature.phase).toBe("staging_deployed");
    expect(r.json.transition.actor).toBe("user");
    expect(r.json.transition.approvedByUser).toBe(true);
    expect(r.json.transition.note).toBe("demo確認OK");
  });

  it("records an immutable audit trail across the happy path to prod", async () => {
    const c = await call(app, env, "POST", "/features", { title: "F" });
    const id = c.json.feature.id;
    await call(app, env, "POST", `/features/${id}/transition`, { to: "demo_review" });
    await call(app, env, "POST", `/features/${id}/transition`, {
      to: "staging_deployed",
      approvedByUser: true,
    });
    await call(app, env, "POST", `/features/${id}/transition`, { to: "staging_review" });
    const shipped = await call(app, env, "POST", `/features/${id}/transition`, {
      to: "prod_shipped",
      approvedByUser: true,
    });
    expect(shipped.status).toBe(200);
    expect(shipped.json.feature.phase).toBe("prod_shipped");

    const detail = await call(app, env, "GET", `/features/${id}`);
    expect(detail.json.transitions).toHaveLength(4);
    expect(detail.json.transitions.map((t: { toPhase: string }) => t.toPhase)).toEqual([
      "demo_review",
      "staging_deployed",
      "staging_review",
      "prod_shipped",
    ]);
    // prod_shipped is terminal: no further edges offered.
    expect(detail.json.allowedTransitions).toHaveLength(0);
  });

  it("rejects an unknown target phase with 400", async () => {
    const c = await call(app, env, "POST", "/features", { title: "F" });
    const id = c.json.feature.id;
    const r = await call(app, env, "POST", `/features/${id}/transition`, { to: "nope" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_phase");
  });

  it("404s a transition on a missing feature", async () => {
    const r = await call(app, env, "POST", "/features/feat_missing/transition", {
      to: "demo_review",
    });
    expect(r.status).toBe(404);
  });

  it("exposes allowedTransitions with approval flags for the UI", async () => {
    const c = await call(app, env, "POST", "/features", { title: "F" });
    const id = c.json.feature.id;
    await call(app, env, "POST", `/features/${id}/transition`, { to: "demo_review" });
    const detail = await call(app, env, "GET", `/features/${id}`);
    const staging = detail.json.allowedTransitions.find(
      (t: { to: string }) => t.to === "staging_deployed",
    );
    expect(staging.requiresApproval).toBe(true);
    const reject = detail.json.allowedTransitions.find(
      (t: { to: string }) => t.to === "demo_rejected",
    );
    expect(reject.requiresApproval).toBe(false);
  });

  it("creates and lists tasks under a feature", async () => {
    const c = await call(app, env, "POST", "/features", { title: "F" });
    const id = c.json.feature.id;
    const t = await call(app, env, "POST", `/features/${id}/tasks`, {
      title: "implement API",
      status: "doing",
    });
    expect(t.status).toBe(201);
    expect(t.json.task.status).toBe("doing");
    const list = await call(app, env, "GET", `/features/${id}/tasks`);
    expect(list.json.tasks).toHaveLength(1);
  });
});

describe("commander-service operator token", () => {
  it("blocks POST without the token and allows it with the token", async () => {
    const app = createApp();
    const env: Env = { DB: makeD1().d1, COMMANDER_OPERATOR_TOKEN: "s3cret" };

    const denied = await call(app, env, "POST", "/features", { title: "F" });
    expect(denied.status).toBe(401);

    const ok = await call(app, env, "POST", "/features", { title: "F" }, {
      "x-commander-token": "s3cret",
    });
    expect(ok.status).toBe(201);

    // reads stay open
    const list = await call(app, env, "GET", "/features");
    expect(list.status).toBe(200);
  });
});

describe("commander-service run persistence", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;

  beforeEach(() => {
    app = createApp();
    env = makeEnv();
  });

  it("persists a run and re-fetches it (1 run round-trip)", async () => {
    const create = await call(app, env, "POST", "/runs", {
      id: "run_test_1",
      prompt: "Reply with PONG",
      cwd: "/tmp/repo",
      status: "pending",
    });
    expect(create.status).toBe(201);
    expect(create.json.run.id).toBe("run_test_1");
    expect(create.json.run.status).toBe("pending");
    expect(create.json.run.exitCode).toBe(null);

    const got = await call(app, env, "GET", "/runs/run_test_1");
    expect(got.status).toBe(200);
    expect(got.json.run.prompt).toBe("Reply with PONG");
    expect(got.json.events).toEqual([]);

    const list = await call(app, env, "GET", "/runs");
    expect(list.json.runs.map((r: { id: string }) => r.id)).toContain("run_test_1");
  });

  it("appends events and folds status/exit into the run row", async () => {
    await call(app, env, "POST", "/runs", { id: "run_test_2", prompt: "p", cwd: "/tmp" });

    const running = await call(app, env, "POST", "/runs/run_test_2/events", {
      type: "status",
      payload: { status: "running" },
    });
    expect(running.status).toBe(201);

    await call(app, env, "POST", "/runs/run_test_2/events", {
      type: "claude",
      payload: { data: { type: "result", result: "PONG" } },
    });
    await call(app, env, "POST", "/runs/run_test_2/events", {
      type: "exit",
      payload: { code: 0 },
    });
    await call(app, env, "POST", "/runs/run_test_2/events", {
      type: "status",
      payload: { status: "succeeded" },
    });

    const got = await call(app, env, "GET", "/runs/run_test_2");
    expect(got.json.run.status).toBe("succeeded"); // folded from the status event
    expect(got.json.run.exitCode).toBe(0); // folded from the exit event
    expect(got.json.events.length).toBe(4);
    const claude = got.json.events.find((e: { type: string }) => e.type === "claude");
    expect(claude.payload.data.result).toBe("PONG"); // payload JSON round-trips
  });

  it("rejects an event for an unknown run (404) and a bad type (400)", async () => {
    const missing = await call(app, env, "POST", "/runs/nope/events", {
      type: "status",
      payload: { status: "running" },
    });
    expect(missing.status).toBe(404);

    await call(app, env, "POST", "/runs", { id: "run_test_3", prompt: "p", cwd: "/tmp" });
    const bad = await call(app, env, "POST", "/runs/run_test_3/events", { type: "bogus" });
    expect(bad.status).toBe(400);
  });

  // ── Task board (Commander home) ────────────────────────────────────────────
  it("POST /tasks creates a feature + task together at demo_building", async () => {
    const r = await call(app, env, "POST", "/tasks", { title: "名簿にロール絞り込み" });
    expect(r.status).toBe(201);
    expect(r.json.feature.phase).toBe("demo_building");
    expect(r.json.task.featureId).toBe(r.json.feature.id);
    expect(r.json.task.status).toBe("todo");
  });

  it("GET /tasks returns each task with its feature phase and latest run", async () => {
    const created = await call(app, env, "POST", "/tasks", { title: "ボード用タスク" });
    const taskId = created.json.task.id;
    // start a run against the task, then drive it to succeeded
    await call(app, env, "POST", "/runs", { id: "run_b1", prompt: "p", cwd: "/wt", taskId });
    await call(app, env, "POST", "/runs/run_b1/events", { type: "status", payload: { status: "succeeded" } });

    const board = await call(app, env, "GET", "/tasks");
    expect(board.status).toBe(200);
    const item = board.json.items.find((i: { taskId: string }) => i.taskId === taskId);
    expect(item.featurePhase).toBe("demo_building");
    expect(item.latestRun.id).toBe("run_b1");
    expect(item.latestRun.status).toBe("succeeded");
    expect(item.latestRun.cwd).toBe("/wt");
  });

  it("GET /tasks picks the NEWEST run per task", async () => {
    const created = await call(app, env, "POST", "/tasks", { title: "再実行タスク" });
    const taskId = created.json.task.id;
    // ids are monotonic like the ULIDs used in prod: the later insert has the greater id.
    await call(app, env, "POST", "/runs", { id: "run_a", prompt: "p1", cwd: "/wt", taskId, status: "failed" });
    await call(app, env, "POST", "/runs", { id: "run_b", prompt: "p2", cwd: "/wt", taskId, status: "running" });
    const board = await call(app, env, "GET", "/tasks");
    const item = board.json.items.find((i: { taskId: string }) => i.taskId === taskId);
    expect(item.latestRun.id).toBe("run_b");
  });

  it("PATCH /tasks/:id archives a task (status done) and 404s an unknown task", async () => {
    const created = await call(app, env, "POST", "/tasks", { title: "アーカイブ対象" });
    const taskId = created.json.task.id;
    const ok = await call(app, env, "PATCH", `/tasks/${taskId}`, { status: "done" });
    expect(ok.status).toBe(200);
    expect(ok.json.task.status).toBe("done");

    const board = await call(app, env, "GET", "/tasks");
    const item = board.json.items.find((i: { taskId: string }) => i.taskId === taskId);
    expect(item.taskStatus).toBe("done");

    const missing = await call(app, env, "PATCH", "/tasks/nope", { status: "done" });
    expect(missing.status).toBe(404);
  });

  it("PATCH /tasks/:id rejects an invalid status (400)", async () => {
    const created = await call(app, env, "POST", "/tasks", { title: "T" });
    const bad = await call(app, env, "PATCH", `/tasks/${created.json.task.id}`, { status: "bogus" });
    expect(bad.status).toBe(400);
  });

  it("extracts artifact URLs from run events onto the task board (P1-2, live)", async () => {
    const created = await call(app, env, "POST", "/tasks", { title: "URL抽出" });
    const taskId = created.json.task.id;
    await call(app, env, "POST", "/runs", { id: "run_url", prompt: "deploy", cwd: "/wt", taskId, status: "running" });

    // demo deploy line, then a PR line — as the daemon would mirror stream-json/stdout.
    await call(app, env, "POST", "/runs/run_url/events", {
      type: "stdout",
      payload: { line: "deployed https://dub-demo-urlx.example.workers.dev" },
    });
    await call(app, env, "POST", "/runs/run_url/events", {
      type: "claude",
      payload: { data: { type: "result", result: "opened PR https://github.com/o/r/pull/99" } },
    });

    const board = await call(app, env, "GET", "/tasks");
    const item = board.json.items.find((i: { taskId: string }) => i.taskId === taskId);
    expect(item.demoUrl).toBe("https://dub-demo-urlx.example.workers.dev");
    expect(item.prUrl).toBe("https://github.com/o/r/pull/99");
    expect(item.stagingUrl).toBeNull();
  });

  it("POST /tasks/backfill-urls recovers URLs from pre-existing run events", async () => {
    const created = await call(app, env, "POST", "/tasks", { title: "バックフィル" });
    const taskId = created.json.task.id;
    await call(app, env, "POST", "/runs", { id: "run_bf", prompt: "p", cwd: "/wt", taskId, status: "succeeded" });
    // Simulate an event stored before extraction existed: still parseable on backfill.
    await call(app, env, "POST", "/runs/run_bf/events", {
      type: "stdout",
      payload: { line: "staging: https://staging-bf.example.workers.dev" },
    });

    const res = await call(app, env, "POST", "/tasks/backfill-urls");
    expect(res.status).toBe(200);
    expect(res.json.updated).toBeGreaterThanOrEqual(1);

    const board = await call(app, env, "GET", "/tasks");
    const item = board.json.items.find((i: { taskId: string }) => i.taskId === taskId);
    expect(item.stagingUrl).toBe("https://staging-bf.example.workers.dev");
  });
});
