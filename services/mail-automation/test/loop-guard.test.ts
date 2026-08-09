import { describe, it, expect } from "vitest";
import { headerLoopReason, selfSenderReason } from "../src/loop-guard";
import { inbound } from "./fakes";

describe("headerLoopReason", () => {
  it("Auto-Submitted != no => auto_submitted", () => {
    expect(headerLoopReason(inbound({ headers: { "auto-submitted": "auto-generated" } }))).toBe("auto_submitted");
  });
  it("Auto-Submitted: no => not a loop", () => {
    expect(headerLoopReason(inbound({ headers: { "auto-submitted": "no" } }))).toBeNull();
  });
  it("Precedence: bulk => precedence_bulk", () => {
    expect(headerLoopReason(inbound({ headers: { precedence: "bulk" } }))).toBe("precedence_bulk");
  });
  it("List-Id present => list_id_present", () => {
    expect(headerLoopReason(inbound({ headers: { "list-id": "<list.example.com>" } }))).toBe("list_id_present");
  });
  it("plain human mail => null", () => {
    expect(headerLoopReason(inbound({ headers: {} }))).toBeNull();
  });
});

describe("selfSenderReason", () => {
  it("matches self domain", () => {
    expect(selfSenderReason(inbound({ from: { email: "auto@developershub.jp" } }), [], ["developershub.jp"])).toBe("self_domain");
  });
  it("matches self address", () => {
    expect(selfSenderReason(inbound({ from: { email: "noreply@x.io" } }), ["noreply@x.io"], [])).toBe("self_address");
  });
  it("external sender => null", () => {
    expect(selfSenderReason(inbound({ from: { email: "human@acme.io" } }), [], ["developershub.jp"])).toBeNull();
  });
});
