import { describe, it, expect } from "vitest";
import { mapPagesStage } from "../src/cf-client";

describe("mapPagesStage", () => {
  it("maps CF Pages stages onto the frozen DeploymentStatus enum", () => {
    expect(mapPagesStage("queued")).toBe("queued");
    expect(mapPagesStage("initialize")).toBe("queued");
    // CF's terminal success stage is "success" -> our enum has no "success", it is "live"
    expect(mapPagesStage("success")).toBe("live");
    expect(mapPagesStage("live")).toBe("live");
    expect(mapPagesStage("failure")).toBe("failed");
    expect(mapPagesStage("canceled")).toBe("failed");
    expect(mapPagesStage("build")).toBe("building");
    expect(mapPagesStage(undefined)).toBe("building");
  });
});
