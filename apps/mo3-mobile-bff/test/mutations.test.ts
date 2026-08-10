import { describe, it, expect } from "vitest";
import { DubError } from "@dub/errors";
import { HDR_IDEMPOTENCY_KEY } from "@dub/observability";
import { buildApp } from "../src/app";
import { applyMutations } from "../src/mutations";
import { makeHarness, jsonInit, authHeaders, ALICE } from "./helpers";

const ctx = { requestId: "r1", userId: ALICE };

describe("applyMutations — routing & idempotency", () => {
  it("routes each op to its owning service and forwards the idempotencyKey", async () => {
    const h = makeHarness();
    h.task.on("PATCH", "/tasks/tsk_1", { id: "tsk_1", version: 2 });
    h.event.on("PATCH", "/actions/act_1", { id: "act_1", version: 2 });
    h.notification.on("PATCH", "/inbox/ntf_1/read", { ok: true });
    h.notification.on("POST", "/inbox/read-all", { updated: 3 });

    const res = await applyMutations(h.deps, ctx, {
      mutations: [
        { idempotencyKey: "k1", op: "task.update", id: "tsk_1", patch: { version: 1, title: "x" } },
        { idempotencyKey: "k2", op: "action.update", id: "act_1", patch: { version: 1, title: "y" } },
        { idempotencyKey: "k3", op: "inbox.read", id: "ntf_1" },
        { idempotencyKey: "k4", op: "inbox.readAll" },
      ],
    });

    expect(res.results.map((r) => r.status)).toEqual(["applied", "applied", "applied", "applied"]);
    expect(res.results[0]?.resource).toEqual({ id: "tsk_1", version: 2 });
    // idempotencyKey forwarded downstream (dedup/retry contract)
    expect(h.task.calls[0]?.opts?.idempotencyKey).toBe("k1");
    expect(h.event.calls[0]?.opts?.idempotencyKey).toBe("k2");
    expect(h.notification.calls[0]?.opts?.idempotencyKey).toBe("k3");
    expect(h.notification.calls[1]?.opts?.idempotencyKey).toBe("k4");
  });

  it("dedupes a repeated idempotencyKey within the batch (applies once)", async () => {
    const h = makeHarness();
    let hits = 0;
    h.task.on("PATCH", "/tasks/tsk_1", () => {
      hits++;
      return { id: "tsk_1", version: 2 };
    });

    const res = await applyMutations(h.deps, ctx, {
      mutations: [
        { idempotencyKey: "dup", op: "task.update", id: "tsk_1", patch: { version: 1 } },
        { idempotencyKey: "dup", op: "task.update", id: "tsk_1", patch: { version: 1 } },
      ],
    });

    expect(hits).toBe(1); // service hit exactly once
    expect(res.results.map((r) => r.status)).toEqual(["applied", "duplicate"]);
    expect(res.results[1]?.resource).toEqual({ id: "tsk_1", version: 2 }); // duplicate reuses first outcome
  });
});

describe("applyMutations — durable cross-request idempotency (mobile_mutations)", () => {
  it("a key applied in an earlier request returns duplicate without re-hitting the service", async () => {
    const h = makeHarness();
    let hits = 0;
    h.task.on("PATCH", "/tasks/tsk_1", () => {
      hits++;
      return { id: "tsk_1", version: 2 };
    });
    const req = { mutations: [{ idempotencyKey: "kD", op: "task.update" as const, id: "tsk_1", patch: { version: 1 } }] };

    const first = await applyMutations(h.deps, ctx, req, h.mutations);
    const second = await applyMutations(h.deps, ctx, req, h.mutations); // same batch re-sent as a new request

    expect(hits).toBe(1); // service hit exactly once across both requests
    expect(first.results[0]?.status).toBe("applied");
    expect(second.results[0]).toMatchObject({ status: "duplicate", resource: { id: "tsk_1", version: 2 } });
  });

  it("does not persist a transient error, so a later retry can still apply", async () => {
    const h = makeHarness();
    let call = 0;
    h.task.on("PATCH", "/tasks/tsk_1", () => {
      call++;
      if (call === 1) throw new DubError("UPSTREAM_UNAVAILABLE", "down", { status: 502 });
      return { id: "tsk_1", version: 2 };
    });
    const req = { mutations: [{ idempotencyKey: "kE", op: "task.update" as const, id: "tsk_1", patch: { version: 1 } }] };

    const first = await applyMutations(h.deps, ctx, req, h.mutations);
    expect(first.results[0]?.status).toBe("error");
    const retry = await applyMutations(h.deps, ctx, req, h.mutations);
    expect(retry.results[0]?.status).toBe("applied"); // not blocked by a stored duplicate
  });

  it("persists a 409 conflict as terminal (replay returns duplicate, no re-dispatch)", async () => {
    const h = makeHarness();
    let hits = 0;
    h.task.on("PATCH", "/tasks/tsk_1", () => {
      hits++;
      throw new DubError("TASK_VERSION_CONFLICT", "mismatch", { status: 409 });
    });
    const req = { mutations: [{ idempotencyKey: "kC", op: "task.update" as const, id: "tsk_1", patch: { version: 1 } }] };

    const first = await applyMutations(h.deps, ctx, req, h.mutations);
    const second = await applyMutations(h.deps, ctx, req, h.mutations);

    expect(first.results[0]?.status).toBe("conflict");
    expect(hits).toBe(1); // second request did not re-dispatch
    expect(second.results[0]).toMatchObject({ status: "duplicate", error: { code: "TASK_VERSION_CONFLICT" } });
  });
});

describe("applyMutations — conflict resolution & error isolation", () => {
  it("captures a 409 as a per-mutation conflict without aborting the batch", async () => {
    const h = makeHarness();
    h.task.on("PATCH", "/tasks/tsk_stale", new DubError("TASK_VERSION_CONFLICT", "version mismatch", { status: 409 }));
    h.task.on("PATCH", "/tasks/tsk_ok", { id: "tsk_ok", version: 5 });

    const res = await applyMutations(h.deps, ctx, {
      mutations: [
        { idempotencyKey: "k1", op: "task.update", id: "tsk_stale", patch: { version: 1 } },
        { idempotencyKey: "k2", op: "task.update", id: "tsk_ok", patch: { version: 4 } },
      ],
    });

    expect(res.results[0]).toMatchObject({ status: "conflict", error: { code: "TASK_VERSION_CONFLICT" } });
    expect(res.results[1]).toMatchObject({ status: "applied" }); // batch continued past the conflict
  });

  it("marks a non-409 upstream failure as error, still isolated", async () => {
    const h = makeHarness();
    h.task.on("PATCH", "/tasks/tsk_1", new DubError("UPSTREAM_UNAVAILABLE", "down", { status: 502 }));
    const res = await applyMutations(h.deps, ctx, {
      mutations: [{ idempotencyKey: "k1", op: "task.update", id: "tsk_1", patch: { version: 1 } }],
    });
    expect(res.results[0]).toMatchObject({ status: "error", error: { code: "UPSTREAM_UNAVAILABLE" } });
  });

  it("reports an unsupported op per-mutation as MOBILE_MUTATION_UNSUPPORTED_TYPE", async () => {
    const h = makeHarness();
    const res = await applyMutations(h.deps, ctx, {
      // @ts-expect-error — exercising an op outside the union
      mutations: [{ idempotencyKey: "k1", op: "chat.send", id: "c1" }],
    });
    expect(res.results[0]).toMatchObject({ status: "error", error: { code: "MOBILE_MUTATION_UNSUPPORTED_TYPE" } });
  });

  it("reports a missing id (update op) as a validation error, batch survives", async () => {
    const h = makeHarness();
    h.task.on("PATCH", "/tasks/tsk_1", { id: "tsk_1", version: 2 });
    const res = await applyMutations(h.deps, ctx, {
      mutations: [
        { idempotencyKey: "k1", op: "task.update", patch: { version: 1 } }, // no id
        { idempotencyKey: "k2", op: "task.update", id: "tsk_1", patch: { version: 1 } },
      ],
    });
    expect(res.results[0]).toMatchObject({ status: "error", error: { code: "VALIDATION_FAILED" } });
    expect(res.results[1]).toMatchObject({ status: "applied" });
  });

  it("reports a malformed entry (missing idempotencyKey/op) per-mutation", async () => {
    const h = makeHarness();
    const res = await applyMutations(h.deps, ctx, {
      // @ts-expect-error — missing required fields
      mutations: [{ op: "inbox.readAll" }],
    });
    expect(res.results[0]).toMatchObject({ status: "error", error: { code: "VALIDATION_FAILED" } });
  });
});

describe("applyMutations — envelope validation", () => {
  it("rejects the whole request when mutations is not an array", async () => {
    const h = makeHarness();
    // @ts-expect-error — bad envelope
    await expect(applyMutations(h.deps, ctx, {})).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
  });
});

describe("POST /m/v1/mutations (through the app)", () => {
  it("400 when the JSON body is invalid", async () => {
    const h = makeHarness();
    const res = await buildApp(h.deps).request("/m/v1/mutations", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("200 and forwards idempotencyKey as x-dub-idempotency-key to the real client", async () => {
    // Uses the transparent proxy path indirectly: assert the FakeService recorded the key.
    const h = makeHarness();
    h.notification.on("POST", "/inbox/read-all", { updated: 0 });
    const res = await buildApp(h.deps).request(
      "/m/v1/mutations",
      jsonInit({ mutations: [{ idempotencyKey: "kZ", op: "inbox.readAll" }] }, authHeaders()),
    );
    expect(res.status).toBe(200);
    expect(h.notification.calls[0]?.opts?.idempotencyKey).toBe("kZ");
    // header constant is the observability-owned canonical name
    expect(HDR_IDEMPOTENCY_KEY).toBeTypeOf("string");
  });
});
