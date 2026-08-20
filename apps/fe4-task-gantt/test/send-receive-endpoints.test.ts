// Data-layer tests: the send/receive endpoint wrappers against the MockApiClient.
// No UI here — this proves the client functions + mock router/handlers agree on shape
// and drive the request lifecycle (issue → list → accept/decline/cancel + cross-links).
import { describe, it, expect } from "vitest";
import { MockApiClient } from "../src/api/mock-client";
import * as api from "../src/api/endpoints";

const ME = "usr_me";
function client() {
  return new MockApiClient({ currentUserId: ME });
}

describe("send/receive data layer (endpoints ↔ mock)", () => {
  it("issue to self → materialises a task (kind:task)", async () => {
    const c = client();
    const res = await api.issueTaskRequest(c, { toUserId: ME, title: "自分用", eventId: "evt_1" });
    expect(res.kind).toBe("task");
    if (res.kind !== "task") throw new Error("expected task");
    expect(res.task.assigneeId).toBe(ME);
  });

  it("issue to another user → pending request (kind:request), listed as outgoing", async () => {
    const c = client();
    const res = await api.issueTaskRequest(c, { toUserId: "usr_bob", title: "おねがい", eventId: "evt_1" });
    expect(res.kind).toBe("request");
    if (res.kind !== "request") throw new Error("expected request");
    expect(res.request.state).toBe("pending");

    const out = await api.listTaskRequests(c, { box: "outgoing" });
    expect(out.items.map((r) => r.id)).toContain(res.request.id);
    const inc = await api.listTaskRequests(c, { box: "incoming" });
    expect(inc.items).toHaveLength(0);
  });

  it("accept → creates the receiver task + a cross-link, moves the request to accepted", async () => {
    const c = client();
    const issued = await api.issueTaskRequest(c, { toUserId: "usr_bob", title: "実装", eventId: "evt_1" });
    if (issued.kind !== "request") throw new Error("expected request");
    const accepted = await api.acceptTaskRequest(c, issued.request.id, { version: issued.request.version });
    expect(accepted.request.state).toBe("accepted");
    expect(accepted.request.createdTaskId).toBe(accepted.createdTask.id);
    expect(accepted.crossLink.requesteeTaskId).toBe(accepted.createdTask.id);
    expect(accepted.crossLink.requesterTaskId).not.toBe(accepted.createdTask.id);

    const links = await api.listTaskCrossLinks(c, "evt_1");
    expect(links.items.map((l) => l.id)).toContain(accepted.crossLink.id);
  });

  it("decline / cancel set state and 409 on a second decide (optimistic)", async () => {
    const c = client();
    const a = await api.issueTaskRequest(c, { toUserId: "usr_bob", title: "却下用" });
    if (a.kind !== "request") throw new Error("expected request");
    const declined = await api.declineTaskRequest(c, a.request.id, { version: a.request.version, reason: "多忙" });
    expect(declined.state).toBe("declined");
    expect(declined.declineReason).toBe("多忙");
    await expect(api.cancelTaskRequest(c, a.request.id, { version: declined.version })).rejects.toMatchObject({
      status: 409,
    });
  });
});
