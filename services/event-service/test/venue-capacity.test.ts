// 会場 / 定員 as structured event fields (#879): the source of truth other apps and the
// AI digest read. Validation is strict so the value stays machine-usable.
import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

describe("venue / capacity", () => {
  it("create + read back + update + clear", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const created = await call(app, "POST", "/events", { body: { title: "北陸IT", venue: "  金沢工業大学 ", capacity: 300 } });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ venue: "金沢工業大学", capacity: 300 });
    const id = created.json.id as string;
    expect((await call(app, "GET", `/events/${id}`)).json).toMatchObject({ venue: "金沢工業大学", capacity: 300 });

    const upd = await call(app, "PATCH", `/events/${id}`, { body: { version: 1, venue: "石川県立図書館", capacity: 250 } });
    expect(upd.status).toBe(200);
    expect(upd.json).toMatchObject({ venue: "石川県立図書館", capacity: 250, version: 2 });
    expect(deps.publisher.events.find((e) => e.name === "event.updated")?.payload).toEqual({ eventId: id, changed: ["venue", "capacity"] });

    const cleared = await call(app, "PATCH", `/events/${id}`, { body: { version: 2, venue: "", capacity: null } });
    expect(cleared.json).toMatchObject({ venue: null, capacity: null });
  });

  it("an event created without them reads as null (old rows too)", async () => {
    const app = createApp(makeDeps());
    const created = await call(app, "POST", "/events", { body: { title: "x" } });
    expect(created.json).toMatchObject({ venue: null, capacity: null });
  });

  it.each([
    [{ capacity: -1 }, "capacity"],
    [{ capacity: 1.5 }, "capacity"],
    [{ capacity: "300" }, "capacity"],
    [{ capacity: 100_001 }, "capacity"],
    [{ venue: 42 }, "venue"],
    [{ venue: "あ".repeat(201) }, "venue"],
  ])("rejects %j", async (bad, field) => {
    const app = createApp(makeDeps());
    const res = await call(app, "POST", "/events", { body: { title: "x", ...bad } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain(field);
  });
});
