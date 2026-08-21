// Unit tests for the member-service client (user → teamIds) used by 送る・受け取る
// routing. Stubs the Fetcher binding directly so the real @dub/http path + the
// response mapping (member?.teamIds ?? [], 404 ⇒ []) are exercised.
import { describe, it, expect } from "vitest";
import type { Fetcher } from "@cloudflare/workers-types";
import type { RequestContext } from "@dub/http";
import type { member } from "@dub/types";
import { createServiceBindingMemberClient } from "../src/clients";

const ctx: RequestContext = { requestId: "req_test" } as RequestContext;

function stubBinding(handler: (req: Request) => Response): Fetcher {
  return { fetch: async (req: Request) => handler(req) } as unknown as Fetcher;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const memberWithTeams: member.Member = {
  id: "mem_1",
  name: "Bob",
  status: "added",
  teamIds: ["team_dev", "team_sponsor"],
  identityUserId: "usr_bob",
} as member.Member;

describe("createServiceBindingMemberClient.teamsOfUser", () => {
  it("hits GET /members/people/by-identity/:id and returns the member's teamIds", async () => {
    let seenPath = "";
    const client = createServiceBindingMemberClient(
      stubBinding((req) => {
        seenPath = new URL(req.url).pathname;
        return jsonRes({ member: memberWithTeams } satisfies member.MemberByIdentityResponse);
      }),
    );
    const teams = await client.teamsOfUser(ctx, "usr_bob");
    expect(teams).toEqual(["team_dev", "team_sponsor"]);
    expect(seenPath).toBe("/members/people/by-identity/usr_bob");
  });

  it("returns [] when no member is linked to the login (member: null)", async () => {
    const client = createServiceBindingMemberClient(
      stubBinding(() => jsonRes({ member: null } satisfies member.MemberByIdentityResponse)),
    );
    expect(await client.teamsOfUser(ctx, "usr_ghost")).toEqual([]);
  });

  it("returns [] on a 404 (treated as no teams, not an error)", async () => {
    const client = createServiceBindingMemberClient(
      stubBinding(() => jsonRes({ error: { code: "NOT_FOUND", message: "no member", retryable: false } }, 404)),
    );
    expect(await client.teamsOfUser(ctx, "usr_ghost")).toEqual([]);
  });
});
