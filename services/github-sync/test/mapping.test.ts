import { describe, it, expect } from "vitest";
import {
  statusToState,
  statusLabel,
  stateToStatus,
  issueLabelsForStatus,
  userLabels,
  diffTaskVsIssue,
  divergedFieldNames,
  matchesLabelFilter,
} from "../src/domain/mapping";
import { isSelfCausedEvent, isSelfCausedWebhook } from "../src/domain/echo";
import { githubMoved, taskMoved, isConflict } from "../src/domain/conflict";
import type { LinkRecord, TaskSnapshot } from "../src/domain/types";

describe("status mapping (theme3 D6 degrade)", () => {
  it("degrades open/closed and carries the 3 extra values on status:* labels", () => {
    expect(statusToState("todo")).toBe("open");
    expect(statusToState("in_progress")).toBe("open");
    expect(statusToState("blocked")).toBe("open");
    expect(statusToState("done")).toBe("closed");
    expect(statusToState("cancelled")).toBe("closed");
    expect(statusLabel("todo")).toBeNull();
    expect(statusLabel("done")).toBeNull();
    expect(statusLabel("in_progress")).toBe("status:in_progress");
    expect(statusLabel("blocked")).toBe("status:blocked");
    expect(statusLabel("cancelled")).toBe("status:cancelled");
  });

  it("recovers status from state + marker, ignoring inconsistent markers", () => {
    expect(stateToStatus("open", [])).toBe("todo");
    expect(stateToStatus("closed", [])).toBe("done");
    expect(stateToStatus("open", ["status:in_progress"])).toBe("in_progress");
    expect(stateToStatus("closed", ["status:cancelled"])).toBe("cancelled");
    // marker inconsistent with state (in_progress is an open status) -> fall back to state
    expect(stateToStatus("closed", ["status:in_progress"])).toBe("done");
  });

  it("builds issue labels preserving user labels + single marker", () => {
    expect(issueLabelsForStatus("in_progress", ["bug", "status:old"])).toEqual(["bug", "status:in_progress"]);
    expect(issueLabelsForStatus("todo", ["bug", "status:blocked"])).toEqual(["bug"]);
    expect(userLabels(["bug", "status:blocked"])).toEqual(["bug"]);
  });
});

describe("diff + label filter", () => {
  const snap: TaskSnapshot = {
    id: "task_1",
    eventId: "evt_1",
    title: "T",
    description: "D",
    status: "in_progress",
    assigneeId: null,
    version: 3,
    updatedAt: "2026-08-09T00:00:00Z",
  };
  it("detects title/description/status divergence", () => {
    const d = diffTaskVsIssue(snap, {
      owner: "o", repo: "r", number: 1, nodeId: "n",
      title: "different", body: "D", state: "open", labels: ["status:in_progress"], assignees: [], updatedAt: "x",
    });
    expect(d.title).toBe(true);
    expect(d.description).toBe(false);
    expect(d.status).toBe(false);
    expect(divergedFieldNames(d)).toEqual(["title"]);
  });
  it("matchesLabelFilter: empty filter matches all; otherwise needs intersection", () => {
    expect(matchesLabelFilter(["a"], [])).toBe(true);
    expect(matchesLabelFilter(["a", "b"], ["b"])).toBe(true);
    expect(matchesLabelFilter(["a"], ["z"])).toBe(false);
  });
});

describe("echo suppression", () => {
  it("drops self-caused domain events and webhooks", () => {
    expect(isSelfCausedEvent("service:github-sync")).toBe(true);
    expect(isSelfCausedEvent("user_1")).toBe(false);
    expect(isSelfCausedEvent(null)).toBe(false);
    expect(isSelfCausedWebhook("dub-sync[bot]", ["dub-sync[bot]"])).toBe(true);
    expect(isSelfCausedWebhook("human", ["dub-sync[bot]"])).toBe(false);
    expect(isSelfCausedWebhook(null, ["dub-sync[bot]"])).toBe(false);
  });
});

describe("movement + conflict predicates", () => {
  const link = (over: Partial<LinkRecord>): LinkRecord => ({
    id: "ghl_1", taskId: "task_1", repoId: "ghr_1", owner: "o", repo: "r",
    issueNumber: 1, issueNodeId: "n", projectItemId: null, syncState: "in_sync",
    lastSyncedAt: "2026-08-09T00:00:00Z", lastGithubUpdatedAt: "2026-08-09T00:00:00Z",
    lastTaskVersion: 2, lastError: null, createdAt: "x", updatedAt: "x", ...over,
  });
  it("detects github/task movement and conflict", () => {
    expect(githubMoved(link({}), "2026-08-09T01:00:00Z")).toBe(true);
    expect(githubMoved(link({}), "2026-08-09T00:00:00Z")).toBe(false);
    expect(taskMoved(link({}), 3)).toBe(true);
    expect(taskMoved(link({}), 2)).toBe(false);
    expect(isConflict({ githubChanged: true, taskChanged: true })).toBe(true);
    expect(isConflict({ githubChanged: true, taskChanged: false })).toBe(false);
  });
});
