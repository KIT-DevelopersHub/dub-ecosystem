// HTTP-level tests for the daemon server: the shared-token gate (ADR 0003) and the
// DELETE /runs/:id cancel route. Runs the real node:http server on an ephemeral
// loopback port and drives it with fetch (no mocks).
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { createDaemonServer } from "../src/server.ts";
import type { DaemonConfig } from "../src/types.ts";
import type { Restarter } from "../src/restart.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude", import.meta.url));
const SLOW_CLAUDE = fileURLToPath(new URL("./fixtures/slow-claude", import.meta.url));

function config(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    port: 0,
    claudeBin: FAKE_CLAUDE,
    defaultCwd: tmpdir(),
    extraArgs: [],
    operatorToken: "",
    idleTimeoutMs: 0,
    runTimeoutMs: 0,
    isolateEnv: false,
    claudeConfigDir: "",
    permissionMode: "acceptEdits",
    ...overrides,
  };
}

let close: (() => Promise<void>) | null = null;

async function listen(cfg: DaemonConfig, restarter?: Restarter): Promise<string> {
  const { server } = createDaemonServer(cfg, restarter);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (close) await close();
  close = null;
});

describe("daemon HTTP — operator token gate", () => {
  it("leaves /health open but 401s /runs without the token, and allows it with it", async () => {
    const base = await listen(config({ operatorToken: "s3cret" }));

    expect((await fetch(`${base}/health`)).status).toBe(200); // always open

    const denied = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(denied.status).toBe(401);

    const ok = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(ok.status).toBe(201);
  });

  it("is open when no token is configured", async () => {
    const base = await listen(config());
    const res = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("daemon HTTP — DELETE /runs/:id cancel", () => {
  it("cancels a running run (202) and 404s an unknown/finished run", async () => {
    const base = await listen(config({ claudeBin: SLOW_CLAUDE }));

    const start = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "long" }),
    });
    const { runId } = (await start.json()) as { runId: string };

    const cancel = await fetch(`${base}/runs/${runId}`, { method: "DELETE" });
    expect(cancel.status).toBe(202);

    const unknown = await fetch(`${base}/runs/nope`, { method: "DELETE" });
    expect(unknown.status).toBe(404);
  });
});

describe("daemon HTTP — POST /admin/restart", () => {
  function fakeRestarter(update: Restarter["update"]) {
    const calls = { update: 0, relaunch: 0 };
    const restarter: Restarter = {
      update: () => {
        calls.update++;
        return update();
      },
      relaunch: () => {
        calls.relaunch++;
      },
    };
    return { restarter, calls };
  }

  it("updates then relaunches, and refuses new runs afterwards", async () => {
    const { restarter, calls } = fakeRestarter(async () => ({ from: "aaa", to: "bbb" }));
    const base = await listen(config(), restarter);

    const res = await fetch(`${base}/admin/restart`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ from: "aaa", to: "bbb" });
    expect(calls).toEqual({ update: 1, relaunch: 1 });

    const again = await fetch(`${base}/admin/restart`, { method: "POST" });
    expect(again.status).toBe(409);
    const run = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(run.status).toBe(503);
  });

  it("refuses while a run is live, without touching the worktree", async () => {
    const { restarter, calls } = fakeRestarter(async () => ({ from: "a", to: "a" }));
    const base = await listen(config({ claudeBin: SLOW_CLAUDE }), restarter);
    const start = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "long" }),
    });
    const { runId } = (await start.json()) as { runId: string };

    const res = await fetch(`${base}/admin/restart`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "runs_active", active: 1 });
    expect(calls).toEqual({ update: 0, relaunch: 0 });

    await fetch(`${base}/runs/${runId}`, { method: "DELETE" });
  });

  it("reports a failed update and does not relaunch", async () => {
    const { restarter, calls } = fakeRestarter(async () => {
      throw new Error("未コミットの変更があります");
    });
    const base = await listen(config(), restarter);
    const res = await fetch(`${base}/admin/restart`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "update_failed", message: "未コミットの変更があります" });
    expect(calls.relaunch).toBe(0);
  });

  it("requires the operator token", async () => {
    const { restarter, calls } = fakeRestarter(async () => ({ from: "a", to: "a" }));
    const base = await listen(config({ operatorToken: "s3cret" }), restarter);
    expect((await fetch(`${base}/admin/restart`, { method: "POST" })).status).toBe(401);
    expect(calls.update).toBe(0);
  });
});
