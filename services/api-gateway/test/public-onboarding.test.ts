import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { makeEnv, fakeBinding, json, execCtx } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };

const ITEM = {
  id: "onb_1",
  title: "Discord に参加",
  description: null,
  url: "https://discord.gg/x",
  sortOrder: 1024,
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
};

const TEAM = { id: "team_pr", name: "広報チーム", color: null };
const MEETING = { teamId: "team_pr", schedule: "毎週水曜 20:00〜", url: "https://meet.google.com/x", updatedAt: ITEM.updatedAt };

describe("GET /api/v1/public/onboarding", () => {
  it("is reachable without a session and reads member-service's internal route s2s", async () => {
    const member = fakeBinding((req) =>
      new URL(req.url).pathname === "/members/internal/onboarding"
        ? json(200, { items: [ITEM], teams: [TEAM], meetings: [MEETING], extra: "dropped" })
        : json(404, { error: { code: "NOT_FOUND", message: "no", retryable: false } }),
    );
    const res = await createApp(NO_RL).fetch(
      new Request("https://x/api/v1/public/onboarding"),
      makeEnv({ SVC_MEMBER: member.fetcher }),
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [ITEM], teams: [TEAM], meetings: [MEETING] });
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(member.requests).toHaveLength(1);
    expect(member.requests[0]!.headers.get("x-dub-internal")).toBeTruthy();
  });
});
