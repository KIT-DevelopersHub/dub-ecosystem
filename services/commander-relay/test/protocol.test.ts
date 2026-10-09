import { describe, expect, it } from "vitest";
import { isSafePath, originAllowed, parseBrowserFrame, routeAgentFrame, scopeId, unscopeId } from "../src/protocol";

describe("parseBrowserFrame", () => {
  it("accepts a well-formed request to each upstream", () => {
    expect(parseBrowserFrame(JSON.stringify({ t: "req", id: "r1", target: "service", method: "GET", path: "/tasks" }))).toEqual({
      t: "req",
      id: "r1",
      target: "service",
      method: "GET",
      path: "/tasks",
    });
    expect(
      parseBrowserFrame(JSON.stringify({ t: "req", id: "r2", target: "daemon", method: "POST", path: "/runs", body: "{}" })),
    ).toMatchObject({ target: "daemon", body: "{}" });
  });

  it("rejects anything that could aim the agent somewhere else", () => {
    const bad = [
      { t: "req", id: "x", target: "internet", method: "GET", path: "/" },
      { t: "req", id: "x", target: "daemon", method: "PUT", path: "/" },
      { t: "req", id: "x", target: "daemon", method: "GET", path: "//evil.example/x" },
      { t: "req", id: "x", target: "daemon", method: "GET", path: "http://evil.example/" },
      { t: "req", id: "x", target: "daemon", method: "GET", path: "/a\r\nHost: x" },
      { t: "req", id: "x~y", target: "daemon", method: "GET", path: "/" },
      { t: "req", id: "x", target: "daemon", method: "GET", path: "/", body: 1 },
      { t: "sub", id: "x", path: "relative" },
      { t: "nope", id: "x" },
    ];
    for (const f of bad) expect(parseBrowserFrame(JSON.stringify(f))).toBeNull();
    expect(parseBrowserFrame("not json")).toBeNull();
  });

  it("caps body size", () => {
    const body = "a".repeat(512 * 1024 + 1);
    expect(parseBrowserFrame(JSON.stringify({ t: "req", id: "x", target: "service", method: "POST", path: "/", body }))).toBeNull();
  });
});

describe("id scoping", () => {
  it("round-trips and keeps browser ids from colliding", () => {
    const s = scopeId("babc", "r1");
    expect(unscopeId(s)).toEqual({ tag: "babc", id: "r1" });
    expect(unscopeId("no-separator")).toBeNull();
    expect(unscopeId(42)).toBeNull();
  });
});

describe("routeAgentFrame", () => {
  it("routes agent responses to the owning browser with the id unscoped", () => {
    const routed = routeAgentFrame(JSON.stringify({ t: "res", id: scopeId("btag", "r9"), status: 200, body: "[]" }));
    expect(routed?.tag).toBe("btag");
    expect(JSON.parse(routed!.out)).toEqual({ t: "res", id: "r9", status: 200, body: "[]" });
  });

  it("drops unknown types and unscoped ids", () => {
    expect(routeAgentFrame(JSON.stringify({ t: "agent", id: scopeId("b", "1") }))).toBeNull();
    expect(routeAgentFrame(JSON.stringify({ t: "res", id: "plain" }))).toBeNull();
    expect(routeAgentFrame("{")).toBeNull();
  });
});

describe("isSafePath / originAllowed", () => {
  it("only absolute single-host paths", () => {
    expect(isSafePath("/runs/abc/events")).toBe(true);
    expect(isSafePath("/chats?kind=ask")).toBe(true);
    expect(isSafePath("/a\\b")).toBe(false);
  });

  it("exact-match origins, no Origin is refused", () => {
    const list = "https://a.example, https://b.example";
    expect(originAllowed("https://b.example", list)).toBe(true);
    expect(originAllowed("https://b.example.evil", list)).toBe(false);
    expect(originAllowed(null, list)).toBe(false);
    expect(originAllowed("https://a.example", undefined)).toBe(false);
  });
});
