// Minimal HTTP + SSE server for the exec bridge. Zero external deps (node:http).
//
// Routes:
//   GET    /health             -> { ok, service, version }        (always open)
//   GET    /                   -> tiny built-in test UI           (always open)
//   POST   /runs               -> { runId }            (body: { prompt, cwd? })
//   GET    /runs               -> Run[]                (history, newest first)
//   GET    /runs/:id           -> Run                  (with buffered events)
//   DELETE /runs/:id           -> 202 (cancel) | 404   (cancel a running run)
//   GET    /runs/:id/events    -> text/event-stream    (replays history, then live)
//
// Auth (ADR 0003): when config.operatorToken is set, every route EXCEPT GET /health
// and GET / requires the shared token — `Authorization: Bearer <token>` or, for the
// SSE stream (EventSource cannot set headers), a `?token=` query param. When the
// token is empty the daemon is open (single-operator loopback dev).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { DaemonConfig } from "./types.ts";
import { RunStore } from "./runner.ts";
import { nullSink, HttpRunSink, type RunSink } from "./sink.ts";
import { INDEX_HTML } from "./index-html.ts";

export const VERSION = "0.1.0";
const SERVICE = "commander-daemon";

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

/** Constant-time token compare; extracts the token from the Bearer header or ?token=. */
function tokenMatches(expected: string, req: IncomingMessage, url: URL): boolean {
  const header = req.headers["authorization"];
  const bearer =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : undefined;
  const presented = bearer ?? url.searchParams.get("token") ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createDaemonServer(config: DaemonConfig) {
  const sink: RunSink = config.serviceUrl
    ? new HttpRunSink(config.serviceUrl, config.serviceToken)
    : nullSink;
  const store = new RunStore(config, sink);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
    const { pathname } = url;
    const method = req.method ?? "GET";

    // CORS preflight (the Dub-hosted frontend calls this loopback daemon).
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
      });
      res.end();
      return;
    }

    // Always-open routes (liveness + zero-build smoke UI).
    if (method === "GET" && pathname === "/health") {
      return json(res, 200, { ok: true, service: SERVICE, version: VERSION });
    }
    if (method === "GET" && pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
      return;
    }

    // Shared-token gate for everything else (when a token is configured).
    if (config.operatorToken && !tokenMatches(config.operatorToken, req, url)) {
      return json(res, 401, { error: "unauthorized" });
    }

    if (method === "POST" && pathname === "/runs") {
      let parsed: { prompt?: unknown; cwd?: unknown; taskId?: unknown };
      try {
        parsed = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return json(res, 400, { error: "invalid_json" });
      }
      if (typeof parsed.prompt !== "string" || parsed.prompt.trim() === "") {
        return json(res, 400, { error: "prompt_required" });
      }
      const cwd = typeof parsed.cwd === "string" ? parsed.cwd : undefined;
      const taskId = typeof parsed.taskId === "string" ? parsed.taskId : undefined;
      const run = store.start({ prompt: parsed.prompt, cwd, taskId });
      return json(res, 201, { runId: run.id, status: run.status });
    }

    if (method === "GET" && pathname === "/runs") {
      return json(res, 200, store.list());
    }

    const runMatch = pathname.match(/^\/runs\/([^/]+)(\/events)?$/);

    // Cancel a running run.
    if (method === "DELETE" && runMatch && !runMatch[2]) {
      const id = runMatch[1]!;
      const cancelled = store.cancel(id);
      if (!cancelled) return json(res, 404, { error: "run_not_active" });
      return json(res, 202, { runId: id, status: "cancelling" });
    }

    if (method === "GET" && runMatch) {
      const id = runMatch[1]!;
      const run = store.get(id);
      if (!run) return json(res, 404, { error: "run_not_found" });

      if (!runMatch[2]) return json(res, 200, run);

      // SSE stream: replay buffered events, then stream live ones.
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      const send = (event: unknown) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      for (const ev of run.events) send(ev);
      // If the run already finished, close after the replay.
      if (run.status === "succeeded" || run.status === "failed") {
        res.end();
        return;
      }
      const unsubscribe = store.subscribe(id, (ev) => {
        send(ev);
        if (ev.type === "status" && (ev.status === "succeeded" || ev.status === "failed")) {
          res.end();
        }
      });
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
      return;
    }

    json(res, 404, { error: "not_found" });
  });

  return { server, store };
}
