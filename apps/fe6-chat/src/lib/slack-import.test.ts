import { describe, it, expect, vi } from "vitest";
import type { SlackImportJob } from "../api/contract";
import { createSlackImportSim, dubChannelIdFor, type ImportedChannel } from "./slack-import-demo";
import {
  describeImportError,
  driveSlackImport,
  jobErrorText,
  normalizeSlackChannelRef,
  stepStates,
} from "./slack-import";

const authors = { me: "usr_me", a: "usr_a", b: "usr_b", disabled: "usr_off" };

function simAt(start = Date.parse("2026-10-15T00:00:00Z")) {
  let t = start;
  const done: ImportedChannel[] = [];
  const sim = createSlackImportSim({ authors, clock: () => t, onDone: (c) => done.push(c) });
  return { sim, done, tick: (ms: number) => (t += ms) };
}

describe("slack-import helpers", () => {
  it("marks steps before the phase complete, the phase current/failed, the rest upcoming", () => {
    expect(stepStates({ phase: "history", status: "running" })).toEqual([
      "complete",
      "complete",
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
    expect(stepStates({ phase: "users", status: "failed" })[0]).toBe("failed");
    expect(stepStates({ phase: "done", status: "done" }).every((s) => s === "complete")).toBe(true);
  });

  it("falls back to the JOB_ERROR_MESSAGES text when the server sends only a code", () => {
    expect(jobErrorText({ code: "not_in_channel", message: "" })).toContain("LMB を招待");
    expect(jobErrorText({ code: "weird" })).toBe("Slack API エラー: weird");
    expect(jobErrorText(null)).toBeNull();
  });

  it("maps 412 to the not-configured sentence and strips #", () => {
    expect(describeImportError({ status: 412 })).toContain("SLACK_BOT_TOKEN");
    expect(describeImportError({ status: 409, message: "x" })).toBe("x");
    expect(normalizeSlackChannelRef("  #general ")).toBe("general");
  });
});

describe("driveSlackImport", () => {
  it("steps until done, waiting out a rate-limit park", async () => {
    const { sim, done, tick } = simAt();
    const created = sim.createJob("#general");
    if (!created.ok) throw new Error("create failed");
    expect(created.status).toBe(201);
    const sleeps: number[] = [];
    const updates: SlackImportJob[] = [];
    const last = await driveSlackImport(
      { stepSlackImport: async (id) => { const r = sim.step(id); if (!r.ok) throw new Error(r.code); return r.value; } },
      created.value,
      { onUpdate: (j) => updates.push(j), sleep: async (ms) => { sleeps.push(ms); tick(ms); } },
    );
    expect(last.status).toBe("done");
    expect(last.counters).toMatchObject({ messages: 5, threadReplies: 3, reactions: 7, pins: 1, files: 2, filesSkipped: 1 });
    expect(updates.some((u) => u.retryAfterMs > 0)).toBe(true);
    expect(sleeps).toContain(1_500);
    // Seeded design-review + the general import just finished.
    expect(done.map((c) => c.name)).toEqual(["design-review", "general"]);
  });

  it("stops when aborted", async () => {
    const { sim } = simAt();
    const created = sim.createJob("random");
    if (!created.ok) throw new Error("create failed");
    const ctrl = new AbortController();
    const step = vi.fn(async (id: string) => {
      ctrl.abort();
      const r = sim.step(id);
      if (!r.ok) throw new Error(r.code);
      return r.value;
    });
    const onUpdate = vi.fn();
    await driveSlackImport({ stepSlackImport: step }, created.value, { onUpdate, signal: ctrl.signal, sleep: async () => {} });
    expect(step).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("slack import simulator", () => {
  it("lists channels archived-last with the latest job per channel", () => {
    const { sim } = simAt();
    const list = sim.listChannels();
    expect(list.at(-1)?.isArchived).toBe(true);
    expect(list.find((c) => c.name === "design-review")?.job?.status).toBe("done");
    expect(list.find((c) => c.name === "sponsor-private")?.job?.status).toBe("failed");
  });

  it("resumes a failed job (200) and 404s an unknown channel", () => {
    const { sim } = simAt();
    const resumed = sim.createJob("sponsor-private");
    expect(resumed.ok && resumed.status).toBe(200);
    expect(resumed.ok && resumed.value.status).toBe("queued");
    const missing = sim.createJob("nope");
    expect(!missing.ok && missing.status).toBe(404);
    const empty = sim.createJob("  ");
    expect(!empty.ok && empty.status).toBe(400);
  });

  it("produces a thread, reactions, bot placeholders, pins and attachments", () => {
    const { done } = simAt();
    const c = done[0]!;
    expect(c.id).toBe(dubChannelIdFor("C04DESIGN"));
    const replies = c.messages.filter((m) => m.threadRootId);
    expect(replies).toHaveLength(3);
    expect(c.messages.find((m) => m.id === replies[0]!.threadRootId)?.replyCount).toBe(3);
    expect(c.placeholderUsers.some((u) => u.displayName.endsWith("(bot)"))).toBe(true);
    expect(c.pinnedIds).toHaveLength(2);
    expect(c.messages.flatMap((m) => m.attachments)).toHaveLength(2);
    const ids = c.messages.map((m) => m.id);
    expect([...ids].sort()).toEqual(ids);
  });
});
