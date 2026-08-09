import { describe, it, expect } from "vitest";
import {
  CONTRACT_VERSION,
  common,
  identity,
  event,
  task,
  auditLog,
  notification,
  webhook,
} from "../src/index";

describe("@dub/types", () => {
  it("declares CONTRACT_VERSION 1.0.0 and API prefixes", () => {
    expect(CONTRACT_VERSION).toBe("1.0.0");
    expect(common.API_PREFIX).toBe("/api/v1");
    expect(common.MOBILE_API_PREFIX).toBe("/m/v1");
  });

  it("PERMISSION_CATALOG is 30 closed keys, 2-segment lowercase, unique", () => {
    const cat = identity.PERMISSION_CATALOG;
    expect(cat.length).toBe(30);
    const keys = cat.map((e) => e.key);
    expect(new Set(keys).size).toBe(30); // unique
    for (const key of keys) {
      const segs = key.split(":");
      expect(segs.length).toBe(2); // <domain>:<action>
      expect(key).toBe(key.toLowerCase());
      expect(key).not.toContain("*"); // no wildcard
    }
    // dangerous flags include the known danger set
    const dangerous = cat.filter((e) => e.dangerous).map((e) => e.key);
    expect(dangerous).toContain("identity:admin");
    expect(dangerous).toContain("infra:deploy");
    expect(dangerous).not.toContain("event:read");
  });

  it("PermissionKey closed union round-trips a valid key", () => {
    const k: identity.PermissionKey = "task:write";
    expect(k).toBe("task:write");
  });

  it("state-machine enums are closed with valid transition tables", () => {
    expect(Object.keys(task.TASK_STATUS_TRANSITIONS).sort()).toEqual(
      ["blocked", "cancelled", "done", "in_progress", "todo"],
    );
    expect(task.TASK_STATUS_TRANSITIONS.done).toEqual(["in_progress"]);
    expect(task.TASK_STATUS_TRANSITIONS.blocked).not.toContain("done"); // via in_progress
    expect(Object.keys(event.EVENT_PHASE_TRANSITIONS).length).toBe(6);
    expect(event.EVENT_PHASE_TRANSITIONS.closed).toEqual([]); // no reopen
    // every transition target must itself be a known phase
    for (const targets of Object.values(event.EVENT_PHASE_TRANSITIONS)) {
      for (const t of targets) {
        expect(event.EVENT_PHASE_TRANSITIONS[t]).toBeDefined();
      }
    }
  });

  it("SYNC_AUDIT_ACTIONS is a closed 5-action catalog", () => {
    expect(auditLog.SYNC_AUDIT_ACTIONS.length).toBe(5);
    expect(auditLog.SYNC_AUDIT_ACTIONS).toContain("identity.role.assigned");
    expect(auditLog.SYNC_AUDIT_ACTIONS).toContain("infra.deploy.executed");
  });

  it("frozen typed shapes compile and round-trip", () => {
    const t: task.Task = {
      id: "task_01J",
      eventId: "event_01J",
      title: "x",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeId: null,
      dueAt: null,
      origin: "internal",
      archivedAt: null,
      createdAt: "2026-08-09T00:00:00Z",
      updatedAt: "2026-08-09T00:00:00Z",
      version: 1,
    };
    const page: common.Paginated<task.Task> = { items: [t], nextCursor: null };
    expect(page.items[0]?.status).toBe("todo");

    const channel: notification.NotificationChannel = "in_app";
    expect(channel).toBe("in_app");

    const env: webhook.WebhookEventEnvelopeV1 = {
      type: "webhook.received",
      version: 1,
      id: "wh_01J",
      source: "github",
      externalId: "gh-1",
      eventKind: "issues.opened",
      receivedAt: "2026-08-09T00:00:00Z",
      requestId: "req_1",
      headers: {},
      payload: null,
      r2Key: null,
    };
    expect(env.type).toBe("webhook.received");
  });

  it("audit input carries requestId (correlation id resolved to requestId, E1)", () => {
    const input: auditLog.AuditRecordInput = {
      action: "task.task.created",
      actorId: "user_1",
      orgId: common.DUB_DEFAULT_ORG_ID,
      result: "success",
      resourceType: "task",
      resourceId: "task_1",
      details: null,
      requestId: "req_1",
      occurredAt: "2026-08-09T00:00:00Z",
    };
    expect(input.requestId).toBe("req_1");
  });
});
