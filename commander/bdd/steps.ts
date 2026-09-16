// Step definitions for every Commander .feature. These drive the REAL daemon +
// commander-service over HTTP/SSE (see support/harness.ts) and the REAL app-registry /
// release-gate for the launcher — no mocks.
import assert from "node:assert/strict";
import { StepRegistry } from "./support/gherkin.ts";
import { World } from "./support/world.ts";
import {
  startDaemon,
  mountService,
  streamRun,
  SLOW_CLAUDE,
  sleep,
} from "./support/harness.ts";
import type { SseEvent } from "./support/harness.ts";

// Launcher SoT: the real app registry (@dub/types) + the real member release gate
// (apps/fe2-app-shell/src/lib/releaseGate.ts). The gate lives in a React app whose
// transitive .tsx types we don't want to pull into this node test's typecheck, so we
// load it at RUNTIME via a dynamic import with a non-literal specifier (tsc types it
// as any; vitest resolves the real module) — the actual release-gate code still runs.
import { appRegistry } from "@dub/types";

interface ReleaseGate {
  isReleaseGatedFor: (appId: string, can: (p: string) => boolean) => boolean;
  isAppPublished: (appId: string | undefined) => boolean;
}
// Non-literal path defeats tsc's static module resolution (stays `any`).
const RELEASE_GATE_PATH = ["..", "..", "apps", "fe2-app-shell", "src", "lib", "releaseGate.ts"].join("/");
async function loadReleaseGate(): Promise<ReleaseGate> {
  return (await import(RELEASE_GATE_PATH)) as ReleaseGate;
}

type Json = Record<string, unknown> & { [k: string]: unknown };

async function http(
  base: string,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: Json | null }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json().catch(() => null)) as Json | null;
  return { status: res.status, json };
}

function lastStatusEvent(events: SseEvent[]): string | undefined {
  const statuses = events.filter((e) => e.type === "status");
  return statuses.length ? statuses[statuses.length - 1]!.status : undefined;
}

/** Start a run (blocking): POST then stream the SSE to completion. */
async function sendPrompt(w: World, prompt: string): Promise<void> {
  const base = w.daemon!.base;
  const headers: Record<string, string> = w.daemonToken
    ? { authorization: `Bearer ${w.daemonToken}` }
    : {};
  const { json } = await http(base, "POST", "/runs", { body: { prompt }, headers });
  w.runId = String(json!.runId);
  w.events = await streamRun(base, w.runId, w.daemonToken);
}

export function defineSteps(): StepRegistry<World> {
  const r = new StepRegistry<World>();

  // ── daemon lifecycle ────────────────────────────────────────────────────────
  r.add(/^daemon が起動している$/, async (w) => {
    w.track((w.daemon = await startDaemon()));
  });
  r.add(/^daemon が低速 claude で起動している$/, async (w) => {
    w.track((w.daemon = await startDaemon({ claudeBin: SLOW_CLAUDE })));
  });
  r.add(/^daemon が短い idle timeout かつ低速 claude で起動している$/, async (w) => {
    // slow-claude emits one init line then goes silent -> the idle watchdog trips.
    w.track(
      (w.daemon = await startDaemon({ claudeBin: SLOW_CLAUDE, idleTimeoutMs: 200, runTimeoutMs: 0 })),
    );
  });
  r.add(/^daemon がトークン "([^"]+)" 付きで起動している$/, async (w, token) => {
    w.daemonToken = token;
    w.track((w.daemon = await startDaemon({ operatorToken: token })));
  });
  r.add(/^daemon が commander-service への永続化を有効にして起動している$/, async (w) => {
    w.track((w.daemon = await startDaemon({ serviceUrl: w.service!.base })));
  });

  // ── service lifecycle ────────────────────────────────────────────────────────
  r.add(/^commander-service が起動している$/, async (w) => {
    w.track((w.service = await mountService()));
  });
  r.add(/^commander-service がトークン "([^"]+)" 付きで起動している$/, async (w, token) => {
    w.serviceToken = token;
    w.track((w.service = await mountService({ token })));
  });

  // ── smoke / run execution ────────────────────────────────────────────────────
  r.add(/^Web からプロンプト "([^"]+)" を送信する$/, async (w, prompt) => {
    await sendPrompt(w, prompt);
  });
  r.add(/^Web からプロンプト "([^"]+)" で run を開始する$/, async (w, prompt) => {
    const { json } = await http(w.daemon!.base, "POST", "/runs", { body: { prompt } });
    w.runId = String(json!.runId);
  });
  r.add(/^run はステータス "running" を経て "succeeded" になる$/, (w) => {
    const statuses = w.events.filter((e) => e.type === "status").map((e) => e.status);
    assert.ok(statuses.includes("running"), `expected a running status, got ${statuses}`);
    assert.equal(lastStatusEvent(w.events), "succeeded");
  });
  r.add(/^SSE で claude の結果 "([^"]+)" が届く$/, (w, expected) => {
    const hit = w.events.some(
      (e) => e.type === "claude" && (e.data as { result?: string })?.result === expected,
    );
    assert.ok(hit, `expected a claude result "${expected}" in the stream`);
  });
  r.add(/^exit コードは 0 である$/, (w) => {
    const exit = w.events.find((e) => e.type === "exit");
    assert.ok(exit, "expected an exit event");
    assert.equal(exit!.code, 0);
  });
  r.add(/^run 履歴から同じ run を再取得できる$/, async (w) => {
    const { status, json } = await http(w.daemon!.base, "GET", "/runs");
    assert.equal(status, 200);
    const ids = (json as unknown as Array<{ id: string }>).map((x) => x.id);
    assert.ok(ids.includes(w.runId!), "run id missing from history");
  });

  // ── cancel / timeout ────────────────────────────────────────────────────────
  r.add(/^実行中に run を cancel する$/, async (w) => {
    const { status } = await http(w.daemon!.base, "DELETE", `/runs/${w.runId}`);
    w.lastStatus = status;
  });
  r.add(/^cancel は 202 で受理される$/, (w) => {
    assert.equal(w.lastStatus, 202);
  });
  r.add(/^run は "failed" で終了する$/, async (w) => {
    if (w.events.length === 0) w.events = await streamRun(w.daemon!.base, w.runId!);
    assert.equal(lastStatusEvent(w.events), "failed");
  });
  r.add(/^error イベントに "([^"]+)" を含むメッセージが出る$/, (w, needle) => {
    const hit = w.events.some(
      (e) => e.type === "error" && (e.message ?? "").includes(needle),
    );
    assert.ok(hit, `expected an error event containing "${needle}"`);
  });

  // ── run persistence (daemon -> service -> D1) ────────────────────────────────
  r.add(/^run の完了を待つ$/, (w) => {
    assert.ok(w.events.length > 0, "run produced no events");
  });
  r.add(/^commander-service から run を再取得できる$/, async (w) => {
    // Persistence is best-effort/async; poll briefly until the run + its events land.
    for (let i = 0; i < 40; i++) {
      const { status, json } = await http(w.service!.base, "GET", `/runs/${w.runId}`);
      const events = (json?.events as unknown[]) ?? [];
      if (status === 200 && events.length > 0) {
        w.lastJson = json as Json;
        return;
      }
      await sleep(50);
    }
    throw new Error("run was not persisted to commander-service in time");
  });
  r.add(/^永続化された run のステータスは "([^"]+)" である$/, (w, expected) => {
    const run = (w.lastJson as { run?: { status?: string } }).run;
    assert.equal(run?.status, expected);
  });
  r.add(/^永続化された run のイベントに claude 結果 "([^"]+)" が含まれる$/, (w, expected) => {
    const events = (w.lastJson as { events?: Array<{ type: string; payload?: unknown }> }).events ?? [];
    const hit = events.some(
      (e) =>
        e.type === "claude" &&
        (((e.payload as { data?: { result?: string } })?.data)?.result === expected),
    );
    assert.ok(hit, `expected a persisted claude result "${expected}"`);
  });

  // ── phase gate (commander-service) ───────────────────────────────────────────
  r.add(/^"([^"]+)" という機能を作成する$/, async (w, title) => {
    const { json } = await http(w.service!.base, "POST", "/features", { body: { title } });
    w.featureId = String((json as { feature: { id: string } }).feature.id);
    w.lastJson = json;
  });
  r.add(/^機能は phase "([^"]+)" で始まる$/, (w, phase) => {
    const f = (w.lastJson as { feature: { phase: string } }).feature;
    assert.equal(f.phase, phase);
  });
  r.add(/^機能を "([^"]+)" へ進める$/, async (w, to) => {
    const res = await http(w.service!.base, "POST", `/features/${w.featureId}/transition`, {
      body: { to },
    });
    w.lastStatus = res.status;
    w.lastJson = res.json;
  });
  r.add(/^機能を "([^"]+)" へ承認付きで進め(?:ようとする|る)$/, async (w, to) => {
    const res = await http(w.service!.base, "POST", `/features/${w.featureId}/transition`, {
      body: { to, approvedByUser: true, note: "demo確認OK" },
    });
    w.lastStatus = res.status;
    w.lastJson = res.json;
  });
  r.add(/^機能を "([^"]+)" へ承認なしで進めようとする$/, async (w, to) => {
    const res = await http(w.service!.base, "POST", `/features/${w.featureId}/transition`, {
      body: { to },
    });
    w.lastStatus = res.status;
    w.lastJson = res.json;
  });
  r.add(/^service の HTTP ステータスは (\d+) である$/, (w, code) => {
    assert.equal(w.lastStatus, Number(code));
  });
  r.add(/^エラーコードは "([^"]+)" である$/, (w, code) => {
    assert.equal((w.lastJson as { error?: string })?.error, code);
  });
  r.add(/^機能の phase は "([^"]+)" の(?:ままである|になる)$/, async (w, phase) => {
    const { json } = await http(w.service!.base, "GET", `/features/${w.featureId}`);
    assert.equal((json as { feature: { phase: string } }).feature.phase, phase);
  });
  r.add(/^機能の phase は "([^"]+)" になる$/, async (w, phase) => {
    const { json } = await http(w.service!.base, "GET", `/features/${w.featureId}`);
    assert.equal((json as { feature: { phase: string } }).feature.phase, phase);
  });
  r.add(
    /^監査ログの最新エントリは actor "([^"]+)" かつ approvedByUser は (true|false) である$/,
    async (w, actor, approved) => {
      const { json } = await http(w.service!.base, "GET", `/features/${w.featureId}`);
      const transitions = (json as { transitions: Array<{ actor: string; approvedByUser: boolean }> })
        .transitions;
      const latest = transitions[transitions.length - 1]!;
      assert.equal(latest.actor, actor);
      assert.equal(latest.approvedByUser, approved === "true");
    },
  );

  // ── shared auth assertions (daemon + service) ────────────────────────────────
  r.add(/^トークンなしで run を作成しようとする$/, async (w) => {
    const { status } = await http(w.daemon!.base, "POST", "/runs", { body: { prompt: "hi" } });
    w.lastStatus = status;
  });
  r.add(/^トークン "([^"]+)" 付きで run を作成する$/, async (w, token) => {
    const { status } = await http(w.daemon!.base, "POST", "/runs", {
      body: { prompt: "hi" },
      headers: { authorization: `Bearer ${token}` },
    });
    w.lastStatus = status;
  });
  r.add(/^daemon の HTTP ステータスは (\d+) である$/, (w, code) => {
    assert.equal(w.lastStatus, Number(code));
  });
  r.add(/^トークン設定時でも daemon の \/health は 200 で開いている$/, async (w) => {
    const { status } = await http(w.daemon!.base, "GET", "/health");
    assert.equal(status, 200);
  });
  r.add(/^トークンなしで機能を作成しようとする$/, async (w) => {
    const { status } = await http(w.service!.base, "POST", "/features", { body: { title: "F" } });
    w.lastStatus = status;
  });
  r.add(/^トークン "([^"]+)" 付きで機能を作成する$/, async (w, token) => {
    const { status } = await http(w.service!.base, "POST", "/features", {
      body: { title: "F" },
      headers: { "x-commander-token": token },
    });
    w.lastStatus = status;
  });
  r.add(/^トークン設定時でも service の GET \/features は 200 で開いている$/, async (w) => {
    const { status } = await http(w.service!.base, "GET", "/features");
    assert.equal(status, 200);
  });

  // ── launcher integration (app registry + release gate) ───────────────────────
  const APP = "commander";
  r.add(/^アプリ "([^"]+)" は登録されている$/, (_w, id) => {
    assert.ok(appRegistry.getApp(id), `app ${id} not in APP_MANIFEST`);
  });
  r.add(/^アプリ "([^"]+)" の navPath は "([^"]+)" である$/, (_w, id, path) => {
    assert.equal(appRegistry.getApp(id)?.navPath, path);
  });
  r.add(/^アプリ "([^"]+)" の閲覧には権限 "([^"]+)" が必要である$/, (_w, id, perm) => {
    assert.equal(appRegistry.appViewKey(id), perm);
  });
  r.add(/^アプリ "([^"]+)" は identity:admin を要求する$/, (_w, id) => {
    const app = appRegistry.getApp(id);
    assert.ok(app?.permissions.includes("identity:admin"), `${id} does not require identity:admin`);
  });
  r.add(/^管理者の閲覧者$/, (w) => {
    w.can = () => true;
  });
  r.add(/^一般メンバーの閲覧者$/, (w) => {
    w.can = () => false;
  });
  r.add(/^管理者にとって Commander はリリースゲートで塞がれない$/, async (w) => {
    const gate = await loadReleaseGate();
    assert.equal(gate.isReleaseGatedFor(APP, w.can), false);
  });
  r.add(/^一般メンバーにとって Commander はリリースゲートで塞がれる$/, async (w) => {
    const gate = await loadReleaseGate();
    assert.equal(gate.isReleaseGatedFor(APP, w.can), true);
  });
  r.add(/^アプリ "([^"]+)" は公開アプリ一覧に含まれない$/, async (_w, id) => {
    const gate = await loadReleaseGate();
    assert.equal(gate.isAppPublished(id), false);
  });

  return r;
}
