import { describe, it, expect } from "vitest";
import { event } from "@dub/types";
import { isDubError } from "@dub/errors";
import { makeDeps, call, createApp, fakeAuthz } from "./harness";
import { EventService, type ReqCtx } from "../src/service";
import type { EventRow } from "../src/types";

const PHASES = ["planning", "preparing", "open", "live", "wrapup", "closed"] as const;
const ctx: ReqCtx = { requestId: "req_test", userId: "user_caller" };

function seedAt(deps: ReturnType<typeof makeDeps>, phase: event.EventPhase, id = "event_x"): void {
  const row: EventRow = {
    id,
    orgId: "org_devhub",
    title: "T",
    description: null,
    phase,
    startsAt: null,
    endsAt: null,
    archivedAt: null,
    version: 1,
    createdBy: "user_seed",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  deps.repo.seedEvent(row);
}

describe("phase transition matrix (test #4)", () => {
  it("only EVENT_PHASE_TRANSITIONS entries succeed; others -> 400 EVENT_INVALID_PHASE_TRANSITION", async () => {
    for (const from of PHASES) {
      for (const to of PHASES) {
        if (from === to) continue;
        const deps = makeDeps(); // grants event:admin, so validity is the only gate
        const svc = new EventService(deps);
        seedAt(deps, from);
        const expectValid = (event.EVENT_PHASE_TRANSITIONS[from] as readonly string[]).includes(to);
        if (expectValid) {
          const res = await svc.updateEvent(ctx, "event_x", { version: 1, phase: to });
          expect(res.phase).toBe(to);
        } else {
          let code = "";
          try {
            await svc.updateEvent(ctx, "event_x", { version: 1, phase: to });
          } catch (e) {
            if (isDubError(e)) code = e.code;
          }
          expect(code).toBe("EVENT_INVALID_PHASE_TRANSITION");
        }
      }
    }
  });

  it("closed is terminal (no outgoing transition)", async () => {
    const deps = makeDeps();
    const svc = new EventService(deps);
    seedAt(deps, "closed");
    await expect(svc.updateEvent(ctx, "event_x", { version: 1, phase: "wrapup" })).rejects.toMatchObject({
      code: "EVENT_INVALID_PHASE_TRANSITION",
    });
  });
});

describe("phase transitions requiring event:admin (test #4)", () => {
  it("forward transition needs only event:write", async () => {
    const deps = makeDeps({ authz: fakeAuthz(new Set(["event:read", "event:write"])) });
    const app = createApp(deps);
    seedAt(deps, "planning", "event_fwd");
    const res = await call(app, "PATCH", "/events/event_fwd", { body: { version: 1, phase: "preparing" } });
    expect(res.status).toBe(200);
    expect(res.json.phase).toBe("preparing");
  });

  it("back-transition without event:admin -> 403", async () => {
    const deps = makeDeps({ authz: fakeAuthz(new Set(["event:read", "event:write"])) });
    const app = createApp(deps);
    seedAt(deps, "preparing", "event_back");
    const res = await call(app, "PATCH", "/events/event_back", { body: { version: 1, phase: "planning" } });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("FORBIDDEN");
  });

  it("wrapup->closed without event:admin -> 403; with admin -> 200", async () => {
    const writeOnly = makeDeps({ authz: fakeAuthz(new Set(["event:read", "event:write"])) });
    const appWrite = createApp(writeOnly);
    seedAt(writeOnly, "wrapup", "event_close");
    const denied = await call(appWrite, "PATCH", "/events/event_close", { body: { version: 1, phase: "closed" } });
    expect(denied.status).toBe(403);

    const admin = makeDeps(); // full grant
    const appAdmin = createApp(admin);
    seedAt(admin, "wrapup", "event_close2");
    const ok = await call(appAdmin, "PATCH", "/events/event_close2", { body: { version: 1, phase: "closed" } });
    expect(ok.status).toBe(200);
    expect(ok.json.phase).toBe("closed");
  });
});

describe("endpoint authorization (test #5) + authn", () => {
  it("missing x-dub-user-id -> 401 on protected routes", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/events", { userId: null });
    expect(res.status).toBe(401);
  });

  it("read-only principal is denied writes (403) but allowed reads (200)", async () => {
    const deps = makeDeps({ authz: fakeAuthz(new Set(["event:read"])) });
    const app = createApp(deps);
    deps.repo.seedEvent({
      id: "event_r", orgId: "org_devhub", title: "R", description: null, phase: "planning",
      startsAt: null, endsAt: null, archivedAt: null, version: 1, createdBy: "u",
      createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect((await call(app, "GET", "/events/event_r")).status).toBe(200);
    expect((await call(app, "POST", "/events", { body: { title: "no" } })).status).toBe(403);
    expect((await call(app, "DELETE", "/events/event_r")).status).toBe(403);
  });

  it("archive requires event:admin (route-level)", async () => {
    const deps = makeDeps({ authz: fakeAuthz(new Set(["event:read", "event:write"])) });
    const app = createApp(deps);
    seedAt(deps, "planning", "event_arch");
    const res = await call(app, "DELETE", "/events/event_arch");
    expect(res.status).toBe(403);
  });
});
