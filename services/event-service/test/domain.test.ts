import { describe, it, expect } from "vitest";
import { event } from "@dub/types";
import {
  isValidPhaseTransition,
  phaseTransitionNeedsAdmin,
  encodeCursor,
  decodeCursor,
  toDubEvent,
  toEventSummary,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from "../src/domain";
import type { EventRow } from "../src/types";

describe("phase helpers align with the frozen EVENT_PHASE_TRANSITIONS", () => {
  it("validity matches the frozen table exactly", () => {
    const phases = Object.keys(event.EVENT_PHASE_TRANSITIONS) as event.EventPhase[];
    for (const from of phases) {
      for (const to of phases) {
        const expected = (event.EVENT_PHASE_TRANSITIONS[from] as readonly string[]).includes(to);
        expect(isValidPhaseTransition(from, to)).toBe(expected);
      }
    }
  });

  it("admin required for back-transitions and ->closed only", () => {
    expect(phaseTransitionNeedsAdmin("planning", "preparing")).toBe(false); // forward
    expect(phaseTransitionNeedsAdmin("preparing", "planning")).toBe(true); // back
    expect(phaseTransitionNeedsAdmin("wrapup", "closed")).toBe(true); // ->closed
    expect(phaseTransitionNeedsAdmin("live", "wrapup")).toBe(false); // forward
    expect(phaseTransitionNeedsAdmin("open", "preparing")).toBe(true); // back
  });
});

describe("cursor codec", () => {
  it("roundtrips a keyset", () => {
    const k = { s: "2026-09-01T00:00:00.000Z", id: "event_000001" };
    expect(decodeCursor(encodeCursor(k))).toEqual(k);
  });
  it("returns null on garbage", () => {
    expect(decodeCursor("not base64 !!!")).toBeNull();
    expect(decodeCursor(btoa(JSON.stringify({ nope: 1 })))).toBeNull();
  });
  it("limit constants match D3 (50/200)", () => {
    expect(DEFAULT_LIMIT).toBe(50);
    expect(MAX_LIMIT).toBe(200);
  });
});

describe("DTO mappers stay within the frozen wire shape", () => {
  it("toDubEvent / toEventSummary never leak the internal created_by column", () => {
    const row: EventRow = {
      id: "event_1", orgId: "org_devhub", title: "T", description: null, phase: "planning",
      startsAt: null, endsAt: null, archivedAt: null, version: 1, createdBy: "user_secret",
      createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z",
    };
    const dto = toDubEvent(row) as unknown as Record<string, unknown>;
    expect(dto.createdBy).toBeUndefined();
    expect(dto.orgId).toBe("org_devhub");
    const summary = toEventSummary(row) as unknown as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual(["id", "phase", "startsAt", "title"]);
  });
});
