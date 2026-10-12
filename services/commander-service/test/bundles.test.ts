import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app";
import { parseBundleReport } from "../src/bundles";
import type { Env } from "../src/env";
import { makeD1 } from "./d1";

const TOKEN = "test-operator-token";

async function call(app: ReturnType<typeof createApp>, env: Env, method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://x${path}`, {
      method,
      headers: { "content-type": "application/json", "x-commander-token": TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env as never,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

describe("staging bundles", () => {
  let app: ReturnType<typeof createApp>;
  let env: Env;
  let t1: string;
  let t2: string;

  beforeEach(async () => {
    app = createApp();
    env = { DB: makeD1().d1, COMMANDER_OPERATOR_TOKEN: TOKEN };
    t1 = (await call(app, env, "POST", "/tasks", { title: "A" })).json.task.id;
    t2 = (await call(app, env, "POST", "/tasks", { title: "B" })).json.task.id;
  });

  it("creates a merging bundle with pending markers and lists it", async () => {
    const r = await call(app, env, "POST", "/bundles", { taskIds: [t1, t2] });
    expect(r.status).toBe(201);
    expect(r.json.bundle).toMatchObject({ taskIds: [t1, t2], status: "merging", slot: null });
    expect(r.json.bundle.markers).toEqual({ [t1]: "pending", [t2]: "pending" });
    expect(r.json.bundle.branch).toBe(`staging/${r.json.bundle.id}`);
    const l = await call(app, env, "GET", "/bundles");
    expect(l.json.bundles).toHaveLength(1);
  });

  it("rejects fewer than 2, unknown tasks and a task already in a bundle", async () => {
    expect((await call(app, env, "POST", "/bundles", { taskIds: [t1] })).status).toBe(400);
    expect((await call(app, env, "POST", "/bundles", { taskIds: [t1, "nope"] })).status).toBe(404);
    await call(app, env, "POST", "/bundles", { taskIds: [t1, t2] });
    const t3 = (await call(app, env, "POST", "/tasks", { title: "C" })).json.task.id;
    const dup = await call(app, env, "POST", "/bundles", { taskIds: [t2, t3] });
    expect(dup.status).toBe(409);
    expect(dup.json.taskIds).toEqual([t2]);
  });

  it("folds the run's BUNDLE_RESULT onto the bundle", async () => {
    const b = (await call(app, env, "POST", "/bundles", { taskIds: [t1, t2] })).json.bundle;
    await call(app, env, "POST", "/runs", { id: "run-b", prompt: "p", cwd: "/r" });
    await call(app, env, "PATCH", `/bundles/${b.id}`, { runId: "run-b" });
    const report = {
      status: "deployed",
      slot: "staging2",
      stagingUrl: "https://dub-fe2-app-shell-staging2.example.workers.dev",
      prUrl: "https://github.com/o/r/pull/9",
      markers: { [t1]: "pass", [t2]: "missing", ghost: "pass" },
    };
    await call(app, env, "POST", "/runs/run-b/events", {
      type: "claude",
      payload: { data: { type: "result", result: `done\nBUNDLE_RESULT ${JSON.stringify(report)}\n` } },
    });
    await call(app, env, "POST", "/runs/run-b/events", { type: "exit", payload: { code: 0 } });
    const got = (await call(app, env, "GET", "/bundles")).json.bundles[0];
    expect(got).toMatchObject({ status: "deployed", slot: "staging2", prUrl: report.prUrl, stagingUrl: report.stagingUrl });
    expect(got.markers).toEqual({ [t1]: "pass", [t2]: "missing" });
  });

  it("marks the bundle failed when its run exits without a report", async () => {
    const b = (await call(app, env, "POST", "/bundles", { taskIds: [t1, t2] })).json.bundle;
    await call(app, env, "POST", "/runs", { id: "run-x", prompt: "p", cwd: "/r" });
    await call(app, env, "PATCH", `/bundles/${b.id}`, { runId: "run-x" });
    await call(app, env, "POST", "/runs/run-x/events", { type: "exit", payload: { code: 1 } });
    expect((await call(app, env, "GET", "/bundles")).json.bundles[0].status).toBe("failed");
  });

  it("removing the last child deletes the bundle; DELETE dissolves", async () => {
    const b = (await call(app, env, "POST", "/bundles", { taskIds: [t1, t2] })).json.bundle;
    const r1 = await call(app, env, "DELETE", `/bundles/${b.id}/tasks/${t1}`);
    expect(r1.json).toMatchObject({ deleted: false, bundle: { taskIds: [t2], markers: { [t2]: "pending" } } });
    const r2 = await call(app, env, "DELETE", `/bundles/${b.id}/tasks/${t2}`);
    expect(r2.json).toEqual({ bundle: null, deleted: true });
    const b2 = (await call(app, env, "POST", "/bundles", { taskIds: [t1, t2] })).json.bundle;
    expect((await call(app, env, "DELETE", `/bundles/${b2.id}`)).status).toBe(200);
    expect((await call(app, env, "DELETE", `/bundles/${b2.id}`)).status).toBe(404);
  });

  it("parseBundleReport ignores absent / malformed / status-less lines", () => {
    expect(parseBundleReport("no report")).toBeNull();
    expect(parseBundleReport("BUNDLE_RESULT {broken")).toBeNull();
    expect(parseBundleReport('BUNDLE_RESULT {"slot":"staging"}')).toBeNull();
    expect(parseBundleReport('BUNDLE_RESULT {"status":"failed","slot":"bogus"}')).toEqual({ status: "failed" });
  });
});
