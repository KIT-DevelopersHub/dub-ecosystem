import { describe, it, expect } from "vitest";
import {
  createLogger,
  requestLogger,
  type LogEntry,
} from "../src/index";
import { HDR_REQUEST_ID, HDR_USER_ID, HDR_CALLER } from "../src/index";

function capture() {
  const lines: LogEntry[] = [];
  return { lines, sink: (e: LogEntry) => lines.push(e) };
}

describe("createLogger", () => {
  it("stamps requestId/userId/caller/service and level on every line", () => {
    const { lines, sink } = capture();
    const log = createLogger({ requestId: "r1", userId: "u1", caller: "api-gateway", sink });
    log.info("hello", { path: "/x" });
    expect(lines).toHaveLength(1);
    const e = lines[0]!;
    expect(e.level).toBe("info");
    expect(e.message).toBe("hello");
    expect(e.requestId).toBe("r1");
    expect(e.userId).toBe("u1");
    expect(e.caller).toBe("api-gateway");
    expect(e.service).toBe("api-gateway"); // defaults to caller
    expect(e.fields).toEqual({ path: "/x" });
    expect(typeof e.time).toBe("string");
  });

  it("redacts secrets in fields before they reach the sink", () => {
    const { lines, sink } = capture();
    const log = createLogger({ requestId: "r1", sink });
    log.warn("auth", { token: "abc", nested: { password: "p" }, keep: "ok" });
    const e = lines[0]!;
    expect(e.fields).toEqual({ token: "[REDACTED]", nested: { password: "[REDACTED]" }, keep: "ok" });
  });

  it("honours minLevel filtering", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, minLevel: "warn" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("child() merges bound fields; per-call fields win", () => {
    const { lines, sink } = capture();
    const log = createLogger({ requestId: "r1", sink, fields: { a: 1 } });
    const child = log.child({ b: 2 });
    child.info("m", { a: 9, c: 3 });
    expect(lines[0]!.fields).toEqual({ a: 9, b: 2, c: 3 });
    expect(child.requestId).toBe("r1");
    expect(child.bindings).toEqual({ a: 1, b: 2 });
  });

  it("omits the fields key entirely when there is nothing to log", () => {
    const { lines, sink } = capture();
    createLogger({ sink }).info("bare");
    expect(lines[0]!.fields).toBeUndefined();
  });
});

describe("requestLogger", () => {
  it("reads correlation from a Headers/Request without minting", () => {
    const { lines, sink } = capture();
    const req = new Request("https://svc.internal/x", {
      headers: {
        [HDR_REQUEST_ID]: "req-123",
        [HDR_USER_ID]: "user-9",
        [HDR_CALLER]: "mo3-bff",
      },
    });
    const log = requestLogger(req, { sink });
    log.info("in");
    const e = lines[0]!;
    expect(e.requestId).toBe("req-123");
    expect(e.userId).toBe("user-9");
    expect(e.caller).toBe("mo3-bff");
  });

  it("leaves requestId unset when the header is absent (no minting here)", () => {
    const { lines, sink } = capture();
    const log = requestLogger(new Headers(), { sink });
    log.info("in");
    expect(lines[0]!.requestId).toBeUndefined();
  });
});
