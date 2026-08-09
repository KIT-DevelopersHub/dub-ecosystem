import { describe, it, expect } from "vitest";
import { isVersionConflict, mapChatError } from "./errors";

describe("mapChatError", () => {
  it("maps UNAUTHENTICATED to reauth", () => {
    expect(mapChatError("UNAUTHENTICATED").action).toBe("reauth");
  });
  it("unifies FORBIDDEN and NOT_FOUND to channel-missing", () => {
    expect(mapChatError("FORBIDDEN").action).toBe("channel-missing");
    expect(mapChatError("NOT_FOUND").action).toBe("channel-missing");
  });
  it("maps VALIDATION_FAILED to inline validation", () => {
    expect(mapChatError("VALIDATION_FAILED").action).toBe("inline-validation");
  });
  it("maps CHAT_ARCHIVED_CHANNEL to archived banner", () => {
    expect(mapChatError("CHAT_ARCHIVED_CHANNEL").action).toBe("archived-banner");
  });
  it("maps <SERVICE>_VERSION_CONFLICT to optimistic rollback", () => {
    expect(mapChatError("CHAT_VERSION_CONFLICT").action).toBe("optimistic-rollback");
    expect(isVersionConflict("CHAT_VERSION_CONFLICT")).toBe(true);
  });
  it("maps RATE_LIMITED without auto-retry", () => {
    expect(mapChatError("RATE_LIMITED").action).toBe("rate-limited");
  });
  it("falls back to a generic toast", () => {
    expect(mapChatError("INTERNAL").action).toBe("generic-toast");
  });
});
