import { describe, expect, it } from "vitest";
import { chunkResponse, CHUNK_CHARS, cwdAllowed, daemonRouteAllowed, drainSse, RelayAgent, sanitizeRunBody, type AgentSocket, type RelayAgentDeps } from "../src/relay-agent.ts";

class FakeSocket implements AgentSocket {
  readyState = 1;
  sent: string[] = [];
  onopen: AgentSocket["onopen"] = null;
  onclose: AgentSocket["onclose"] = null;
  onerror: AgentSocket["onerror"] = null;
  onmessage: AgentSocket["onmessage"] = null;
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
}

function setup(fetchImpl: typeof fetch) {
  const sock = new FakeSocket();
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const deps: RelayAgentDeps = {
    openSocket: () => sock,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    }) as typeof fetch,
    log: () => {},
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
  };
  const agent = new RelayAgent(
    { relayUrl: "wss://relay/ws/agent", relaySecret: "s", daemonUrl: "http://127.0.0.1:4319", serviceUrl: "http://127.0.0.1:8798", operatorToken: "tok", cwdRoots: ["/work"] },
    deps,
  );
  agent.start();
  return { agent, sock, calls, timers, frames: () => sock.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s)) };
}

describe("RelayAgent requests", () => {
  it("forwards to the named loopback upstream with the operator token, never a browser-chosen host", async () => {
    const { agent, calls, frames } = setup(async () => new Response('{"items":[]}', { status: 200 }));
    await agent.handle(JSON.stringify({ t: "req", id: "b1~r1", target: "service", method: "GET", path: "/tasks" }));
    await agent.handle(JSON.stringify({ t: "req", id: "b1~r2", target: "daemon", method: "POST", path: "/runs", body: '{"prompt":"x","cwd":"/work/wt1","args":["--disallowedTools","Task"]}' }));
    expect(calls[0]!.url).toBe("http://127.0.0.1:8798/tasks");
    expect((calls[0]!.init!.headers as Record<string, string>)["x-commander-token"]).toBe("tok");
    expect(calls[1]!.url).toBe("http://127.0.0.1:4319/runs");
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ prompt: "x", cwd: "/work/wt1", args: ["--disallowedTools", "Task"] });
    expect(frames()).toEqual([
      { t: "res", id: "b1~r1", status: 200, body: '{"items":[]}', more: false },
      { t: "res", id: "b1~r2", status: 200, body: '{"items":[]}', more: false },
    ]);
  });

  it("refuses unsafe paths without fetching", async () => {
    const { agent, calls, frames } = setup(async () => new Response("x"));
    await agent.handle(JSON.stringify({ t: "req", id: "b~1", target: "service", method: "GET", path: "//evil.example/" }));
    await agent.handle(JSON.stringify({ t: "req", id: "b~2", target: "elsewhere", method: "GET", path: "/" }));
    expect(calls).toHaveLength(0);
    expect(frames().map((f) => f.status)).toEqual([400, 400]);
  });

  it("reports a down upstream as 502", async () => {
    const { agent, frames } = setup(async () => {
      throw new Error("ECONNREFUSED");
    });
    await agent.handle(JSON.stringify({ t: "req", id: "b~1", target: "daemon", method: "GET", path: "/health" }));
    expect(frames()[0]).toMatchObject({ t: "res", status: 502 });
  });
});

describe("RelayAgent SSE", () => {
  it("relays each SSE data payload then ends", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('data: {"type":"status","status":"running"}\n\ndata: {"type":"st'));
        c.enqueue(enc.encode('dout","line":"hi"}\n\n'));
        c.close();
      },
    });
    const { agent, frames } = setup(async () => new Response(stream, { status: 200 }));
    await agent.handle(JSON.stringify({ t: "sub", id: "b~s1", path: "/runs/r1/events" }));
    expect(frames()).toEqual([
      { t: "ev", id: "b~s1", data: '{"type":"status","status":"running"}' },
      { t: "ev", id: "b~s1", data: '{"type":"stdout","line":"hi"}' },
      { t: "end", id: "b~s1" },
    ]);
  });

  it("aborts a browser's streams when the relay says it is gone", async () => {
    let aborted = false;
    const { agent } = setup(async (_u, init) => {
      init!.signal!.addEventListener("abort", () => (aborted = true));
      return new Response(new ReadableStream({ start() {} }), { status: 200 });
    });
    void agent.handle(JSON.stringify({ t: "sub", id: "btab~s1", path: "/runs/r1/events" }));
    await new Promise((r) => setTimeout(r, 0));
    await agent.handle(JSON.stringify({ t: "gone", tag: "btab" }));
    expect(aborted).toBe(true);
  });
});

describe("helpers", () => {
  it("chunks large bodies under the frame cap and reassembles exactly", () => {
    const body = "x".repeat(CHUNK_CHARS * 2 + 5);
    const frames = chunkResponse("i", 200, body).map((f) => JSON.parse(f));
    expect(frames.map((f) => f.t)).toEqual(["res", "part", "part"]);
    expect(frames.map((f) => f.more)).toEqual([true, true, false]);
    expect(frames.map((f) => f.body).join("")).toBe(body);
  });

  it("drainSse keeps a partial event for the next read", () => {
    expect(drainSse("data: a\n\ndata: b")).toEqual({ events: ["a"], rest: "data: b" });
  });
});

describe("runs under plain node", () => {
  it("loads with --experimental-strip-types (no TS-only syntax needing a transform)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const file = fileURLToPath(new URL("../src/relay-agent.ts", import.meta.url));
    const out = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "-e", `import(${JSON.stringify(file)}).then(m => console.log(typeof m.RelayAgent))`],
      { encoding: "utf8" },
    );
    expect(out.trim()).toBe("function");
  });
});

describe("remote surface of the daemon", () => {
  it("relays only the routes the UI needs", () => {
    expect(daemonRouteAllowed("GET", "/health")).toBe(true);
    expect(daemonRouteAllowed("POST", "/runs")).toBe(true);
    expect(daemonRouteAllowed("DELETE", "/runs/abc-1")).toBe(true);
    expect(daemonRouteAllowed("GET", "/")).toBe(false);
    expect(daemonRouteAllowed("POST", "/runs/abc")).toBe(false);
    expect(daemonRouteAllowed("GET", "/runs/a/b")).toBe(false);
  });

  it("refuses claude flags that would widen permissions, and cwd outside the roots", () => {
    expect(sanitizeRunBody('{"prompt":"p","args":["--dangerously-skip-permissions"]}', ["/work"])).toBeNull();
    expect(sanitizeRunBody('{"prompt":"p","args":["--settings","/tmp/x.json"]}', ["/work"])).toBeNull();
    expect(sanitizeRunBody('{"prompt":"p","args":["--disallowedTools","--permission-mode"]}', ["/work"])).toBeNull();
    expect(sanitizeRunBody('{"prompt":"p","cwd":"/etc"}', ["/work"])).toBeNull();
    expect(sanitizeRunBody('{"prompt":"p","cwd":"/work/../etc"}', ["/work"])).toBeNull();
    expect(sanitizeRunBody('{"prompt":"p","cwd":"/workshop"}', ["/work"])).toBeNull();
    // Unknown fields never reach the daemon.
    expect(JSON.parse(sanitizeRunBody('{"prompt":"p","extra":1,"taskId":"t"}', ["/work"])!)).toEqual({ prompt: "p", taskId: "t" });
    expect(cwdAllowed("/work", ["/work/"])).toBe(true);
  });

  it("answers 403 without calling the daemon", async () => {
    const { agent, calls, frames } = setup(async () => new Response("{}"));
    await agent.handle(JSON.stringify({ t: "req", id: "b~1", target: "daemon", method: "POST", path: "/runs", body: '{"prompt":"p","args":["--dangerously-skip-permissions"]}' }));
    await agent.handle(JSON.stringify({ t: "req", id: "b~2", target: "daemon", method: "GET", path: "/" }));
    await agent.handle(JSON.stringify({ t: "sub", id: "b~3", path: "/health" }));
    expect(calls).toHaveLength(0);
    expect(frames().map((f) => f.status ?? f.error)).toEqual([403, 403, "bad_request"]);
  });
});

describe("link lifecycle", () => {
  it("reconnects with backoff after a normal drop", () => {
    const { sock, timers } = setup(async () => new Response(""));
    sock.onopen?.({});
    const before = timers.length;
    sock.onclose?.({ code: 1006 });
    expect(timers.length).toBe(before + 1);
    expect(timers.at(-1)!.ms).toBe(1_000);
  });

  it("does not reconnect after being replaced by another agent (no eviction loop)", () => {
    const { sock, timers } = setup(async () => new Response(""));
    sock.onopen?.({});
    const before = timers.length;
    sock.onclose?.({ code: 4000 });
    expect(timers.length).toBe(before);
  });

  it("drops a half-dead link when pongs stop", () => {
    const { sock, timers } = setup(async () => new Response(""));
    const realNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;
      sock.onopen?.({});
      timers.at(-1)!.fn(); // first ping, pong still fresh
      expect(sock.sent).toContain("ping");
      now += 120_000; // no pong for 2 minutes
      timers.at(-1)!.fn();
      expect(sock.readyState).toBe(3);
      expect(timers.at(-1)!.ms).toBe(1_000); // reconnect scheduled
    } finally {
      Date.now = realNow;
    }
  });
});
