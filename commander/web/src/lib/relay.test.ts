import { describe, expect, it, vi } from "vitest";
import { HttpCommanderApi } from "./commanderApi.ts";
import { HttpCommanderClient, type DaemonRunEvent } from "./client.ts";
import { RelayConnection, type RelayStatus } from "./relay.ts";

class FakeWs {
  static last: FakeWs | null = null;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeWs.last = this;
  }
  send(d: string) {
    this.sent.push(JSON.parse(d) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

async function connected() {
  const relay = new RelayConnection(async () => ({ ticket: "t k", wsUrl: "wss://relay/ws/browser" }), {
    WebSocketCtor: FakeWs as never,
  });
  const statuses: RelayStatus[] = [];
  relay.onStatus((s) => statuses.push(s));
  relay.connect();
  await vi.waitFor(() => expect(FakeWs.last).not.toBeNull());
  const ws = FakeWs.last!;
  ws.open();
  return { relay, ws, statuses };
}

describe("RelayConnection", () => {
  it("opens the socket with the ticket and reports the agent's presence", async () => {
    FakeWs.last = null;
    const { ws, statuses } = await connected();
    expect(ws.url).toBe("wss://relay/ws/browser?ticket=t%20k");
    ws.push({ t: "agent", online: true });
    ws.push({ t: "agent", online: false });
    expect(statuses).toEqual(["connecting", "online", "agent_offline"]);
  });

  it("carries the existing HttpCommanderApi over the relay, chunked bodies included", async () => {
    FakeWs.last = null;
    const { relay, ws } = await connected();
    const api = new HttpCommanderApi("https://ignored", "never-sent", relay.fetchFor("service"));
    const p = api.listBoard();
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    const req = ws.sent[0]!;
    expect(req).toMatchObject({ t: "req", target: "service", method: "GET", path: "/tasks" });
    ws.push({ t: "res", id: req.id, status: 200, body: '{"items":[{"taskId":', more: true });
    ws.push({ t: "part", id: req.id, body: '"t1"}]}', more: false });
    expect(await p).toEqual([{ taskId: "t1" }]);
  });

  it("streams run events and drops the token query param", async () => {
    FakeWs.last = null;
    const { relay, ws } = await connected();
    const client = new HttpCommanderClient("https://ignored", "secret", relay.fetchFor("daemon"), relay.streamOpener());
    const events: DaemonRunEvent[] = [];
    let closed = false;
    client.streamEvents("run1", (e) => events.push(e), () => (closed = true));
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    const sub = ws.sent[0]!;
    expect(sub).toEqual({ t: "sub", id: sub.id, path: "/runs/run1/events" });
    ws.push({ t: "ev", id: sub.id, data: JSON.stringify({ type: "stdout", line: "hi" }) });
    ws.push({ t: "ev", id: sub.id, data: JSON.stringify({ type: "status", status: "succeeded" }) });
    expect(events.map((e) => e.type)).toEqual(["stdout", "status"]);
    expect(closed).toBe(true);
    expect(ws.sent.at(-1)).toEqual({ t: "unsub", id: sub.id });
  });

  it("fails in-flight calls when the socket drops, so the UI shows 'unreachable' instead of hanging", async () => {
    FakeWs.last = null;
    const { relay, ws, statuses } = await connected();
    const client = new HttpCommanderClient("https://ignored", undefined, relay.fetchFor("daemon"));
    const health = client.health();
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    ws.close();
    expect(await health).toBe(false);
    expect(statuses.at(-1)).toBe("disconnected");
    relay.close();
  });
});
