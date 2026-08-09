import { describe, it, expect } from "vitest";
import { isDubError } from "@dub/errors";
import type { GithubRepoConfig, SyncRunRecord } from "../src/domain/types";
import { makeHarness, issue, fixedNow, type Harness } from "./helpers";

async function seedRepo(h: Harness, over?: Partial<GithubRepoConfig>): Promise<GithubRepoConfig> {
  const r: GithubRepoConfig = {
    id: "ghr_main", owner: "acme", repo: "web", eventId: "evt_1", defaultActionId: null,
    origin: "github", direction: "bidirectional", enabled: true, installationId: null,
    projectNumber: null, labelFilter: [], createdBy: "user_1", createdAt: fixedNow(), updatedAt: fixedNow(),
    ...over,
  };
  await h.stores.repos.create(r);
  return r;
}

async function expectDubError(p: Promise<unknown>, code: string, status: number): Promise<void> {
  try {
    await p;
    throw new Error("expected throw");
  } catch (err) {
    expect(isDubError(err)).toBe(true);
    if (isDubError(err)) {
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
    }
  }
}

describe("links service", () => {
  it("creates a manual link and returns the frozen GithubLink shape", async () => {
    const h = makeHarness();
    await seedRepo(h);
    h.github.seed(issue({ owner: "acme", repo: "web", number: 12 }));
    const link = await h.service.createLink("req", { taskId: "task_a", owner: "acme", repo: "web", issueNumber: 12 });
    expect(link).toEqual({
      taskId: "task_a",
      repo: "acme/web",
      issueNumber: 12,
      url: "https://github.com/acme/web/issues/12",
      linkedAt: fixedNow(),
    });
    expect(h.publisher.count("link_created")).toBe(1);
  });

  it("rejects a duplicate issue link with 409", async () => {
    const h = makeHarness();
    await seedRepo(h);
    h.github.seed(issue({ owner: "acme", repo: "web", number: 12 }));
    await h.service.createLink("req", { taskId: "task_a", owner: "acme", repo: "web", issueNumber: 12 });
    await expectDubError(
      h.service.createLink("req", { taskId: "task_b", owner: "acme", repo: "web", issueNumber: 12 }),
      "GITHUB_LINK_ALREADY_EXISTS",
      409,
    );
  });

  it("rejects linking against an unregistered repo with 404", async () => {
    const h = makeHarness();
    await expectDubError(
      h.service.createLink("req", { taskId: "task_a", owner: "acme", repo: "ghost", issueNumber: 1 }),
      "GITHUB_REPO_NOT_FOUND",
      404,
    );
  });

  it("lists links filtered by repo", async () => {
    const h = makeHarness();
    await seedRepo(h);
    h.github.seed(issue({ owner: "acme", repo: "web", number: 1 }));
    await h.service.createLink("req", { taskId: "task_a", owner: "acme", repo: "web", issueNumber: 1 });
    const page = await h.service.listLinks("req", { repo: "acme/web" });
    expect(page.items.length).toBe(1);
    expect(page.items[0]!.repo).toBe("acme/web");
    expect(page.nextCursor).toBeNull();
  });

  it("deleting an unknown link returns 404", async () => {
    const h = makeHarness();
    await expectDubError(h.service.deleteLink("req", "ghl_missing"), "GITHUB_LINK_NOT_FOUND", 404);
  });
});

describe("repos service", () => {
  it("registers a repo (event validated) and rejects duplicates", async () => {
    const h = makeHarness();
    h.events.known.add("evt_1");
    const repo = await h.service.registerRepo("req", "user_1", { owner: "acme", repo: "web", eventId: "evt_1" });
    expect(repo.origin).toBe("github"); // frozen default
    expect(repo.direction).toBe("bidirectional");
    await expectDubError(
      h.service.registerRepo("req", "user_1", { owner: "acme", repo: "web", eventId: "evt_1" }),
      "GITHUB_REPO_ALREADY_REGISTERED",
      409,
    );
  });

  it("rejects registration for an unknown eventId", async () => {
    const h = makeHarness();
    await expectDubError(
      h.service.registerRepo("req", "user_1", { owner: "acme", repo: "web", eventId: "nope" }),
      "GITHUB_VALIDATION_FAILED",
      400,
    );
  });
});

describe("sync runs service", () => {
  it("scope=all reconciles enabled repos and records stats + sync_completed", async () => {
    const h = makeHarness();
    await seedRepo(h);
    h.github.seed(issue({ owner: "acme", repo: "web", number: 1, title: "A" }));
    h.github.seed(issue({ owner: "acme", repo: "web", number: 2, title: "B" }));
    const res = await h.service.triggerSync("req", "user_1", { scope: "all" });
    expect(res.status).toBe("succeeded");
    const run = await h.service.getRun(res.runId);
    expect(run.stats.created).toBe(2);
    expect(h.publisher.count("sync_completed")).toBe(1);
  });

  it("rejects a concurrent sync of the same scope with 409", async () => {
    const h = makeHarness();
    const active: SyncRunRecord = {
      id: "ghs_active", scope: "all", repoId: null, status: "running", stats: { created: 0, updated: 0, skipped: 0, conflicts: 0, failed: 0 },
      triggeredBy: "user_1", startedAt: fixedNow(), finishedAt: null, error: null, createdAt: fixedNow(),
    };
    await h.stores.runs.create(active);
    await expectDubError(h.service.triggerSync("req", "user_1", { scope: "all" }), "GITHUB_SYNC_IN_PROGRESS", 409);
  });

  it("scope=task requires a linked task", async () => {
    const h = makeHarness();
    const res = await h.service.triggerSync("req", "user_1", { scope: "task", targetId: "task_unlinked" });
    // reconcile throws LINK_NOT_FOUND inside execute -> run recorded partial_failed
    expect(res.status).toBe("partial_failed");
    const run = await h.service.getRun(res.runId);
    expect(run.error).toContain("task not linked");
  });

  it("getRun 404 for unknown id", async () => {
    const h = makeHarness();
    await expectDubError(h.service.getRun("ghs_nope"), "NOT_FOUND", 404);
  });
});
