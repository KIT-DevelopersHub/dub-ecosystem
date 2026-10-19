import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { sha256 } from "../src/sha256";

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("sha256 (pure, platform-neutral)", () => {
  it("matches node:crypto across block boundaries and multi-byte text", () => {
    for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(200), "slack-import:msg:C1:1.0 日本語🎉"]) {
      expect(hex(sha256(s))).toBe(createHash("sha256").update(s).digest("hex"));
    }
  });
});
