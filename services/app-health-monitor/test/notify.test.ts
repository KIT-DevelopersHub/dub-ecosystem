import { describe, it, expect, vi } from "vitest";
import { createNotifier } from "../src/notify";
import type { Env } from "../src/env";
import type { TargetResult } from "../src/types";

const target: TargetResult = { id: "fe:mail", kind: "frontend", label: "画面: メール", status: "down", detail: "HTTP 404 chunk missing" };

function captureEnv() {
  const calls: { path: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetcher = {
    fetch: vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      calls.push({ path: url.pathname, body: await req.json().catch(() => null), headers });
      return new Response(JSON.stringify({ notificationId: "n1", deduplicated: false }), { status: 202 });
    }),
  };
  const env = { SVC_NOTIFICATION: fetcher } as unknown as Env;
  return { env, calls };
}

describe("createNotifier — admin fan-out shape", () => {
  it("down: POSTs /notify with admin roles, ops.health type, channels in_app, streak-scoped dedupKey", async () => {
    const { env, calls } = captureEnv();
    await createNotifier(env).down(target, "2026-08-19T00:00:00.000Z");
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.path).toBe("/notify");
    expect(c.headers["x-dub-internal"]).toBeDefined(); // internal marker attached by the service client
    const body = c.body as Record<string, unknown>;
    expect(body.type).toBe("ops.health");
    expect(body.recipientRoles).toEqual(["role_sys_admin", "role_sys_maintainer"]);
    expect(body.recipientIds).toEqual([]);
    expect(body.channels).toEqual(["in_app"]);
    expect(body.dedupKey).toBe("health:down:fe:mail:2026-08-19T00:00:00.000Z");
    expect(String(body.title)).toContain("開けない可能性");
    expect(body.resourceType).toBe("health");
  });

  it("recovery: POSTs /notify with a distinct up dedupKey", async () => {
    const { env, calls } = captureEnv();
    await createNotifier(env).recovery(target, "2026-08-19T00:00:00.000Z");
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.dedupKey).toBe("health:up:fe:mail:2026-08-19T00:00:00.000Z");
    expect(String(body.title)).toContain("復旧");
  });

  it("best-effort: a notify failure never throws", async () => {
    const fetcher = { fetch: vi.fn(async () => new Response("boom", { status: 500 })) };
    const env = { SVC_NOTIFICATION: fetcher } as unknown as Env;
    await expect(createNotifier(env).down(target, "t")).resolves.toBeUndefined();
  });

  it("no binding: swallowed, no throw", async () => {
    const env = {} as Env;
    await expect(createNotifier(env).down(target, "t")).resolves.toBeUndefined();
  });
});
