// Wire-contract "4th face" (Dart / Flutter desktop). The existing wire-params.test
// reconciles fe-client ⟷ spec ⟷ server query keys. The desktop reaches per-service
// reads through the gateway proxy, so it is a fourth independent client that could
// re-introduce the gantt `?event=` vs `?eventId=` class of drift on every release.
//
// The desktop declares its proxied query keys ONCE in kDesktopWire (Dart), exported
// to apps/dt1-desktop/contract/desktop_wire.g.json. This test reconciles each op that
// has a `<SVC>_WIRE` counterpart in @dub/types: every key the desktop sends must be a
// real key of the SoT descriptor for that operationId. Shipping `{ event: ... }` on
// the Dart side turns this red — the same guard the web client has.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gantt, notification, event } from "@dub/types";

type WireOp = { method: string; path: string; query: string[] };

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const desktopWire: Record<string, WireOp> = JSON.parse(
  readFileSync(`${ROOT}apps/dt1-desktop/contract/desktop_wire.g.json`, "utf8"),
);

/** operationId → the SoT `<SVC>_WIRE` descriptor entry it must conform to. */
const SOT: Record<string, { query: readonly string[] } | undefined> = {
  getGantt: gantt.GANTT_WIRE.getGantt,
  listInbox: notification.NOTIFICATION_WIRE.listInbox,
  listEvents: event.EVENT_WIRE.listEvents,
  // listTasks: task-service has no `<SVC>_WIRE` descriptor yet — see the gap test below.
};

describe("desktop wire keys reconcile with the @dub/types SoT (4th face)", () => {
  for (const [op, desc] of Object.entries(desktopWire)) {
    const sot = SOT[op];
    if (!sot) continue;
    it(`${op}: every desktop query key exists in the SoT (${sot.query.join(", ")})`, () => {
      const unknown = desc.query.filter((k) => !sot.query.includes(k));
      expect(
        unknown,
        `desktop op "${op}" sends keys absent from the SoT: ${unknown.join(", ")}`,
      ).toEqual([]);
    });
  }

  it("proves the gantt ?event= regression would fail here", () => {
    // Guard the exact PR#231 mistake: were the desktop to send `event`, it is not a
    // key of GANTT_WIRE.getGantt (['eventId']) and this reconciliation would catch it.
    expect(gantt.GANTT_WIRE.getGantt.query).toContain("eventId");
    expect(gantt.GANTT_WIRE.getGantt.query).not.toContain("event");
    expect(desktopWire.getGantt.query).toContain("eventId");
    expect(desktopWire.getGantt.query).not.toContain("event");
  });

  it("documents the task-service gap (no `<SVC>_WIRE` descriptor yet)", () => {
    // The desktop already reads tasks; when task-service gains a TASK_WIRE descriptor
    // in @dub/types, add it to SOT above so listTasks is reconciled too.
    expect(SOT.listTasks).toBeUndefined();
    expect(desktopWire.listTasks.query).toEqual(["eventId", "assigneeId"]);
  });
});
