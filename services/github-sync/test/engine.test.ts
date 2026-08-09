import { describe, it, expect } from "vitest";
import { DubError } from "@dub/errors";
import type { GithubRepoConfig, LinkRecord, SyncDirection, SyncOrigin } from "../src/domain/types";
import type { task } from "@dub/types";
import { makeHarness, issue, fixedNow, type Harness } from "./helpers";
import { parseIssueEvent } from "../src/engine/parse";

function repo(h: Harness, over?: Partial<GithubRepoConfig>): GithubRepoConfig {
  const r: GithubRepoConfig = {
    id: "ghr_main", owner: "acme", repo: "web", eventId: "evt_1", defaultActionId: null,
    origin: "github", direction: "bidirectional", enabled: true, installationId: null,
    projectNumber: null, labelFilter: [], createdBy: "user_1", createdAt: fixedNow(), updatedAt: fixedNow(),
    ...over,
  };
  return r;
}

async function seedRepo(h: Harness, over?: Partial<GithubRepoConfig>): Promise<GithubRepoConfig> {
  const r = repo(h, over);
  await h.stores.repos.create(r);
  return r;
}

async function seedLink(h: Harness, over: Partial<LinkRecord> & { taskId: string; repoId: string; issueNumber: number }): Promise<LinkRecord> {
  const l: LinkRecord = {
    id: "ghl_1", owner: "acme", repo: "web", issueNodeId: "node_5", projectItemId: null,
    syncState: "in_sync", lastSyncedAt: fixedNow(), lastGithubUpdatedAt: fixedNow(),
    lastTaskVersion: 1, lastError: null, createdAt: fixedNow(), updatedAt: fixedNow(), ...over,
  };
  await h.stores.links.create(l);
  return l;
}

function seedTask(h: Harness, over: Partial<task.Task> & { id: string }): task.Task {
  const t: task.Task = {
    eventId: "evt_1", title: "Task", description: "Body", status: "todo",
    priority: "medium", assigneeId: null, dueAt: null, origin: "github", archivedAt: null,
    createdAt: fixedNow(), updatedAt: fixedNow(), version: 1, ...over,
  };
  h.tasks.seed(t);
  return t;
}

const webhookEvent = (action: string, iss: ReturnType<typeof issue>, sender = "human") =>
  parseIssueEvent({
    action,
    sender: { login: sender },
    repository: { name: iss.repo, owner: { login: iss.owner } },
    issue: {
      number: iss.number, node_id: iss.nodeId, title: iss.title, body: iss.body,
      state: iss.state, labels: iss.labels.map((n) => ({ name: n })),
      assignees: iss.assignees.map((login) => ({ login })), updated_at: iss.updatedAt,
    },
  })!;

describe("GitHub -> internal (webhook)", () => {
  it("imports a newly opened issue as an origin=github task + link + link_created", async () => {
    const h = makeHarness();
    await seedRepo(h);
    const ev = webhookEvent("opened", issue({ owner: "acme", repo: "web", number: 5, title: "New" }));
    const res = await h.engine.applyWebhook("req_1", ev);
    expect(res).toBe("created");
    const createCall = h.tasks.calls.find((c) => c.op === "createTask");
    expect(createCall).toBeTruthy();
    expect((createCall!.input as task.CreateTaskRequest).origin).toBe("github");
    const link = await h.stores.links.getByIssue("ghr_main", 5);
    expect(link?.syncState).toBe("in_sync");
    expect(h.publisher.count("link_created")).toBe(1);
  });

  it("edited issue patches the linked task (title/body) and keeps it in_sync", async () => {
    const h = makeHarness();
    const r = await seedRepo(h);
    seedTask(h, { id: "task_10", title: "Old", version: 1 });
    await seedLink(h, { id: "ghl_10", taskId: "task_10", repoId: r.id, issueNumber: 5, lastTaskVersion: 1, lastGithubUpdatedAt: "2026-08-09T00:00:00Z" });
    const ev = webhookEvent("edited", issue({ owner: "acme", repo: "web", number: 5, title: "Renamed", updatedAt: "2026-08-09T06:00:00Z" }));
    const res = await h.engine.applyWebhook("req_2", ev);
    expect(res).toBe("updated");
    expect(h.tasks.tasks.get("task_10")!.title).toBe("Renamed");
    const link = await h.stores.links.getByIssue(r.id, 5);
    expect(link?.syncState).toBe("in_sync");
    expect(link?.lastTaskVersion).toBe(2);
  });

  it("suppresses echo when the webhook sender is our own App", async () => {
    const h = makeHarness({ selfLogins: ["dub-sync[bot]"] });
    await seedRepo(h);
    const ev = webhookEvent("opened", issue({ owner: "acme", repo: "web", number: 9 }), "dub-sync[bot]");
    const res = await h.engine.applyWebhook("req_3", ev);
    expect(res).toBe("skipped");
    expect(h.tasks.calls.length).toBe(0);
  });

  it("skips a newly opened issue that fails the label filter", async () => {
    const h = makeHarness();
    await seedRepo(h, { labelFilter: ["sync"] });
    const ev = webhookEvent("opened", issue({ owner: "acme", repo: "web", number: 7, labels: ["other"] }));
    const res = await h.engine.applyWebhook("req_4", ev);
    expect(res).toBe("skipped");
    expect(h.tasks.calls.length).toBe(0);
  });

  it("treats 422 TASK_GITHUB_ORIGIN_READONLY as permanent: error state, no throw", async () => {
    const h = makeHarness();
    const r = await seedRepo(h);
    seedTask(h, { id: "task_20", version: 1 });
    await seedLink(h, { id: "ghl_20", taskId: "task_20", repoId: r.id, issueNumber: 5, lastTaskVersion: 1, lastGithubUpdatedAt: "2026-08-09T00:00:00Z" });
    h.tasks.updateBehavior = () => {
      throw new DubError("TASK_GITHUB_ORIGIN_READONLY", "readonly", { status: 422, retryable: false });
    };
    const ev = webhookEvent("edited", issue({ owner: "acme", repo: "web", number: 5, title: "X", updatedAt: "2026-08-09T06:00:00Z" }));
    const res = await h.engine.applyWebhook("req_5", ev);
    expect(res).toBe("failed");
    const link = await h.stores.links.getByIssue(r.id, 5);
    expect(link?.syncState).toBe("error");
    expect(link?.lastError).toContain("TASK_GITHUB_ORIGIN_READONLY");
  });

  it("resolves a conflict on the origin side (github wins) and emits conflict_detected", async () => {
    const h = makeHarness();
    const r = await seedRepo(h, { origin: "github" });
    seedTask(h, { id: "task_30", title: "TaskTitle", version: 5 }); // task moved (link had v1)
    await seedLink(h, { id: "ghl_30", taskId: "task_30", repoId: r.id, issueNumber: 5, lastTaskVersion: 1, lastGithubUpdatedAt: "2026-08-09T00:00:00Z" });
    const ev = webhookEvent("edited", issue({ owner: "acme", repo: "web", number: 5, title: "IssueWins", updatedAt: "2026-08-09T06:00:00Z" }));
    const res = await h.engine.applyWebhook("req_6", ev);
    expect(res).toBe("conflict");
    expect(h.publisher.count("conflict_detected")).toBe(1);
    expect(h.tasks.tasks.get("task_30")!.title).toBe("IssueWins"); // github overwrote task
  });
});

describe("internal -> GitHub (domain events)", () => {
  it("pushes a task update to the linked issue and advances lastTaskVersion", async () => {
    const h = makeHarness();
    const r = await seedRepo(h, { origin: "internal", direction: "bidirectional" });
    seedTask(h, { id: "task_40", title: "NewTitle", status: "todo", version: 2 });
    h.github.seed(issue({ owner: "acme", repo: "web", number: 5, title: "OldIssue", updatedAt: "2026-08-09T00:00:00Z" }));
    await seedLink(h, { id: "ghl_40", taskId: "task_40", repoId: r.id, issueNumber: 5, lastTaskVersion: 1, lastGithubUpdatedAt: "2026-08-09T00:00:00Z" });
    const res = await h.engine.applyTaskUpsert("req_7", "user_1", "task_40");
    expect(res).toBe("updated");
    expect(h.github.countOp("updateIssue")).toBe(1);
    const link = await h.stores.links.getByTaskId("task_40");
    expect(link?.lastTaskVersion).toBe(2);
  });

  it("suppresses echo for self-caused task events", async () => {
    const h = makeHarness();
    const r = await seedRepo(h);
    await seedLink(h, { id: "ghl_50", taskId: "task_50", repoId: r.id, issueNumber: 5 });
    const res = await h.engine.applyTaskUpsert("req_8", "service:github-sync", "task_50");
    expect(res).toBe("skipped");
    expect(h.github.calls.length).toBe(0);
  });

  it("does not write to GitHub for a github_to_internal repo", async () => {
    const h = makeHarness();
    const r = await seedRepo(h, { direction: "github_to_internal" as SyncDirection });
    seedTask(h, { id: "task_60", version: 2 });
    await seedLink(h, { id: "ghl_60", taskId: "task_60", repoId: r.id, issueNumber: 5 });
    const res = await h.engine.applyTaskUpsert("req_9", "user_1", "task_60");
    expect(res).toBe("skipped");
    expect(h.github.countOp("updateIssue")).toBe(0);
  });

  it("maps assignee via githubLogin; missing login skips assignee without error", async () => {
    const h = makeHarness();
    const r = await seedRepo(h, { origin: "internal" });
    // assignee has NO githubLogin mapping -> assignees skipped, other fields still sync
    seedTask(h, { id: "task_70", title: "Changed", assigneeId: "user_x", version: 2 });
    h.github.seed(issue({ owner: "acme", repo: "web", number: 5, title: "Old", updatedAt: "2026-08-09T00:00:00Z" }));
    await seedLink(h, { id: "ghl_70", taskId: "task_70", repoId: r.id, issueNumber: 5, lastTaskVersion: 1, lastGithubUpdatedAt: "2026-08-09T00:00:00Z" });
    const res = await h.engine.applyTaskUpsert("req_10", "user_1", "task_70");
    expect(res).toBe("updated");
    const call = h.github.calls.find((c) => c.op === "updateIssue")!;
    // assignees omitted (null -> not sent) because login unresolved
    expect((call.input as { assignees?: string[] }).assignees).toBeUndefined();
  });

  it("archives: comments + closes the issue, never deletes it", async () => {
    const h = makeHarness();
    const r = await seedRepo(h);
    h.github.seed(issue({ owner: "acme", repo: "web", number: 5 }));
    await seedLink(h, { id: "ghl_80", taskId: "task_80", repoId: r.id, issueNumber: 5 });
    const res = await h.engine.applyTaskArchived("req_11", "user_1", "task_80");
    expect(res).toBe("updated");
    expect(h.github.countOp("addComment")).toBe(1);
    const closeCall = h.github.calls.find((c) => c.op === "updateIssue")!;
    expect((closeCall.input as { state: string }).state).toBe("closed");
  });
});

describe("event.archived", () => {
  it("disables all repo configs for the event, keeping links", async () => {
    const h = makeHarness();
    await seedRepo(h, { id: "ghr_a", owner: "acme", repo: "web", eventId: "evt_x" });
    await seedRepo(h, { id: "ghr_b", owner: "acme", repo: "api", eventId: "evt_x" });
    await seedRepo(h, { id: "ghr_c", owner: "acme", repo: "docs", eventId: "evt_other" });
    const n = await h.engine.applyEventArchived("evt_x");
    expect(n).toBe(2);
    expect((await h.stores.repos.get("ghr_a"))!.enabled).toBe(false);
    expect((await h.stores.repos.get("ghr_b"))!.enabled).toBe(false);
    expect((await h.stores.repos.get("ghr_c"))!.enabled).toBe(true);
  });
});
