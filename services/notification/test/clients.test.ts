// Guards the identity port's outbound contract. Role → user-id expansion MUST target
// the internal S2S route GET /internal/users (x-dub-internal gated), NOT the bare
// GET /users (no list handler → 404) nor the permission-gated GET /identity/users.
// Regression for: feedback → admin inbox notifications silently failing because the
// role fan-out call 404'd and was swallowed as best-effort.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import { makeIdentityPort } from "../src/clients";
import { ctx } from "./helpers";

// Records the path + query of every request and answers role expansion with a page.
function recordingIdentity(): { binding: Fetcher; paths: string[] } {
  const paths: string[] = [];
  const binding = {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      paths.push(url.pathname + url.search);
      const body = { items: [{ id: "usr_admin1" }, { id: "usr_admin2" }], nextCursor: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
  return { binding, paths };
}

describe("makeIdentityPort.listUserIdsByRole", () => {
  it("calls the internal S2S route /internal/users?roleKey= and maps ids", async () => {
    const { binding, paths } = recordingIdentity();
    const port = makeIdentityPort(binding);
    const ids = await port.listUserIdsByRole("role_sys_admin", ctx());
    expect(ids).toEqual(["usr_admin1", "usr_admin2"]);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("/internal/users?roleKey=role_sys_admin");
    // never the bare /users (404s) or the permission-gated /identity/users
    expect(paths[0]!.startsWith("/internal/users")).toBe(true);
  });
});
