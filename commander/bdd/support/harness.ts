// Test harness: spins the REAL commander pieces on ephemeral loopback ports and
// drives them over HTTP/SSE — no mocks.
//   - mountService: the real Hono commander-service app on a node http server,
//     backed by the real in-memory D1 (real migration).
//   - startDaemon: the real commander-daemon node:http server (spawns a fake claude
//     fixture so no real Claude Code is invoked).
//   - streamRun: consumes the daemon SSE stream via fetch (node has no EventSource
//     guaranteed in every runner), collecting events until the stream closes.
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";

import { createApp } from "../../../services/commander-service/src/app.ts";
import type { Env } from "../../../services/commander-service/src/env.ts";
import { createDaemonServer } from "../../daemon/src/server.ts";
import type { DaemonConfig } from "../../daemon/src/types.ts";
import { makeD1 } from "./d1.ts";

/** Permissive shape of a daemon SSE event (all payload fields optional) so the steps
 *  can read any field after a `type` check without discriminated-union narrowing. */
export interface SseEvent {
  type: "status" | "claude" | "stdout" | "stderr" | "exit" | "error";
  at?: string;
  status?: "pending" | "running" | "succeeded" | "failed";
  data?: unknown;
  line?: string;
  code?: number | null;
  message?: string;
}

export const FAKE_CLAUDE = fileURLToPath(
  new URL("../../daemon/test/fixtures/fake-claude", import.meta.url),
);
export const SLOW_CLAUDE = fileURLToPath(
  new URL("../../daemon/test/fixtures/slow-claude", import.meta.url),
);

export interface Running {
  base: string;
  close: () => Promise<void>;
}

async function listen(server: Server): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Mount the real commander-service Hono app on a node http server + in-memory D1. */
export async function mountService(opts: { token?: string } = {}): Promise<Running> {
  const app = createApp();
  const env: Env = opts.token
    ? { DB: makeD1().d1, COMMANDER_OPERATOR_TOKEN: opts.token }
    : { DB: makeD1().d1 };

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
    }
    const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
      method: req.method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const response = await app.fetch(request, env as never);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  return listen(server);
}

/** Start the real commander-daemon (fake claude fixture by default). */
export async function startDaemon(overrides: Partial<DaemonConfig> = {}): Promise<Running> {
  const config: DaemonConfig = {
    port: 0,
    claudeBin: FAKE_CLAUDE,
    defaultCwd: tmpdir(),
    extraArgs: [],
    operatorToken: "",
    runTimeoutMs: 0,
    ...overrides,
  };
  const { server } = createDaemonServer(config);
  return listen(server);
}

/** Consume a run's SSE stream via fetch; resolves with all events once it closes. */
export async function streamRun(
  base: string,
  runId: string,
  token?: string,
): Promise<SseEvent[]> {
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  const res = await fetch(`${base}/runs/${runId}/events${q}`);
  if (!res.ok || !res.body) throw new Error(`SSE returned ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const l of frame.split("\n")) {
        const line = l.trimStart();
        if (line.startsWith("data:")) {
          const json = line.slice("data:".length).trim();
          if (json) events.push(JSON.parse(json) as SseEvent);
        }
      }
    }
  }
  return events;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
