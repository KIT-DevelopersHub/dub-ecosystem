// /operate/* for the daemon. Kept transport-free (method + path + raw body in, status +
// JSON out) so server.ts only forwards and the logic is testable without a socket.
//
//   GET  /operate/catalog  -> { configured, environment, entries }
//   POST /operate/preview  -> Preview            (body: { plan })
//   POST /operate/execute  -> ExecutionResult    (body: { previewId, skip? })

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CATALOG } from "./catalog.ts";
import { OperateExecutor, type AuditSink } from "./executor.ts";
import { environmentLabel, GatewayClient, type Fetch, type GatewayConfig } from "./gateway.ts";
import { parsePlan } from "./plan.ts";

export interface OperateConfig extends GatewayConfig {
  /** JSONL file every execution is appended to. */
  auditLogPath: string;
}

export interface OperateReply {
  status: number;
  body: unknown;
}

export function fileAuditSink(path: string): AuditSink {
  return {
    append(record) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    },
  };
}

const NOT_CONFIGURED = "Dub API の接続先が未設定です（daemon の COMMANDER_DUB_API_BASE とボットユーザーの認証情報を設定してください）";

export function createOperateHandler(config: OperateConfig | undefined, deps: { fetch?: Fetch; audit?: AuditSink } = {}) {
  const executor = config
    ? new OperateExecutor(new GatewayClient(config, deps.fetch), deps.audit ?? fileAuditSink(config.auditLogPath))
    : null;

  return async function handle(method: string, pathname: string, rawBody: string): Promise<OperateReply> {
    if (method === "GET" && pathname === "/operate/catalog") {
      return {
        status: 200,
        body: {
          configured: Boolean(config),
          environment: config ? environmentLabel(config.baseUrl) : null,
          entries: CATALOG,
        },
      };
    }
    if (method !== "POST" || (pathname !== "/operate/preview" && pathname !== "/operate/execute")) {
      return { status: 404, body: { error: "not_found" } };
    }
    if (!executor) return { status: 503, body: { error: NOT_CONFIGURED } };

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody || "{}") as Record<string, unknown>;
    } catch {
      return { status: 400, body: { error: "リクエストの形式が不正です" } };
    }

    if (pathname === "/operate/preview") {
      const plan = parsePlan(parsed.plan);
      if (!plan.ok) return { status: 422, body: { error: "計画に問題があります", blockers: plan.errors } };
      return { status: 200, body: await executor.preview(plan.plan) };
    }

    if (typeof parsed.previewId !== "string") return { status: 400, body: { error: "previewId がありません" } };
    const skip = Array.isArray(parsed.skip) ? parsed.skip.filter((s): s is string => typeof s === "string") : [];
    const result = await executor.execute(parsed.previewId, skip);
    return "error" in result ? { status: 409, body: result } : { status: 200, body: result };
  };
}
