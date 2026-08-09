import { describe, it, expect } from "vitest";
import type { MessageBatch, R2Bucket } from "@cloudflare/workers-types";
import type { DubEventEnvelope, WebhookEventEnvelopeV1 } from "@dub/events";
import type { GithubRepoConfig, LinkRecord } from "../src/domain/types";
import type { task } from "@dub/types";
import { makeHarness, issue, fixedNow, type Harness } from "./helpers";
import { handleWebhookBatch, buildDomainEventHandler, resolvePayload } from "../src/queue";

function fakeBatch<T>(queue: string, bodies: T[]): { batch: MessageBatch<T>; acks: number[]; retries: number[] } {
  const acks: number[] = [];
  const retries: number[] = [];
  const messages = bodies.map((body, i) => ({
    id: `m${i}`,
    body,
    ack: () => acks.push(i),
    retry: () => retries.push(i),
  }));
  return { batch: { queue, messages } as unknown as MessageBatch<T>, acks, retries };
}

function fakeR2(entries: Record<string, string>): R2Bucket {
  return {
    get: async (key: string) => {
      const v = entries[key];
      return v === undefined ? null : ({ text: async () => v } as unknown);
    },
  } as unknown as R2Bucket;
}

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

function webhookEnvelope(id: string, iss: ReturnType<typeof issue>): WebhookEventEnvelopeV1 {
  return {
    type: "webhook.received", version: 1, id, source: "github", externalId: `gh_${id}`,
    eventKind: "issues", receivedAt: fixedNow(), requestId: "req_wh",
    headers: {}, r2Key: null,
    payload: {
      action: "opened", sender: { login: "human" },
      repository: { name: iss.repo, owner: { login: iss.owner } },
      issue: { number: iss.number, node_id: iss.nodeId, title: iss.title, body: iss.body, state: iss.state, labels: [], assignees: [], updated_at: iss.updatedAt },
    },
  };
}

describe("wh-github consumer", () => {
  it("dedups redelivery of the same envelope.id (at-least-once)", async () => {
    const h = makeHarness();
    await seedRepo(h);
    const deps = { engine: h.engine, processed: h.stores.processed, webhookRaw: fakeR2({}) };
    const env = webhookEnvelope("wh_1", issue({ owner: "acme", repo: "web", number: 5 }));

    const b1 = fakeBatch("dub-q-wh-github", [env]);
    await handleWebhookBatch(b1.batch, deps);
    const b2 = fakeBatch("dub-q-wh-github", [env]);
    await handleWebhookBatch(b2.batch, deps);

    expect(h.tasks.calls.filter((c) => c.op === "createTask").length).toBe(1);
    expect(b1.acks).toEqual([0]);
    expect(b2.acks).toEqual([0]);
  });

  it("retries on a transient handler failure", async () => {
    const h = makeHarness();
    // no repo registered -> applyWebhook returns skipped (no throw); force a throw instead:
    const deps = {
      engine: {
        applyWebhook: async () => {
          throw new Error("boom");
        },
      } as unknown as typeof h.engine,
      processed: h.stores.processed,
      webhookRaw: fakeR2({}),
    };
    const env = webhookEnvelope("wh_err", issue({ owner: "acme", repo: "web", number: 5 }));
    const b = fakeBatch("dub-q-wh-github", [env]);
    await handleWebhookBatch(b.batch, deps);
    expect(b.retries).toEqual([0]);
    expect(b.acks).toEqual([]);
  });
});

describe("R2 payload fallback", () => {
  it("fetches the raw body from R2 when the envelope offloaded it (>96KB)", async () => {
    const body = JSON.stringify({ hello: "world" });
    const r2 = fakeR2({ "raw/abc": body });
    const env: WebhookEventEnvelopeV1 = {
      type: "webhook.received", version: 1, id: "wh_big", source: "github", externalId: "x",
      eventKind: "issues", receivedAt: fixedNow(), requestId: "r", headers: {}, payload: null, r2Key: "raw/abc",
    };
    const resolved = await resolvePayload(env, r2);
    expect(resolved).toEqual({ hello: "world" });
  });
});

describe("evt-github-sync consumer", () => {
  async function seedLinkedTask(h: Harness): Promise<void> {
    await seedRepo(h, { origin: "internal" });
    const t: task.Task = {
      id: "task_q", eventId: "evt_1", title: "NewTitle", description: "B", status: "todo",
      priority: "medium", assigneeId: null, dueAt: null, origin: "internal", archivedAt: null,
      createdAt: fixedNow(), updatedAt: fixedNow(), version: 2,
    };
    h.tasks.seed(t);
    h.github.seed(issue({ owner: "acme", repo: "web", number: 5, title: "OldIssue", updatedAt: "2026-08-09T00:00:00Z" }));
    const link: LinkRecord = {
      id: "ghl_q", taskId: "task_q", repoId: "ghr_main", owner: "acme", repo: "web", issueNumber: 5,
      issueNodeId: "node_5", projectItemId: null, syncState: "in_sync", lastSyncedAt: fixedNow(),
      lastGithubUpdatedAt: "2026-08-09T00:00:00Z", lastTaskVersion: 1, lastError: null,
      createdAt: fixedNow(), updatedAt: fixedNow(),
    };
    await h.stores.links.create(link);
  }

  function taskUpdated(id: string): DubEventEnvelope<"task.updated"> {
    return {
      name: "task.updated", version: 1, id, occurredAt: fixedNow(), requestId: "req_evt",
      actorId: "user_1", payload: { taskId: "task_q", eventId: "evt_1", changed: ["title"] },
    };
  }

  it("dedups the same domain envelope.id and writes to GitHub only once", async () => {
    const h = makeHarness();
    await seedLinkedTask(h);
    const handler = buildDomainEventHandler({ engine: h.engine, processed: h.stores.processed, webhookRaw: fakeR2({}) });
    const ev = taskUpdated("evt_1_dup");

    const b1 = fakeBatch("dub-q-evt-github-sync", [ev]);
    await handler(b1.batch as MessageBatch<DubEventEnvelope>, {});
    const b2 = fakeBatch("dub-q-evt-github-sync", [ev]);
    await handler(b2.batch as MessageBatch<DubEventEnvelope>, {});

    expect(h.github.countOp("updateIssue")).toBe(1);
    expect(b1.acks).toEqual([0]);
    expect(b2.acks).toEqual([0]);
  });
});
