import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

const dm = (memberIds: string[], extra: Record<string, unknown> = {}) => ({ type: "dm", memberIds, ...extra });

describe("direct messages", () => {
  it("creates a private DM with memberIds; nobody is channel admin", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "POST", "/chat/channels", { body: dm(["user_b"], { visibility: "public" }) });
    expect(res.status).toBe(201);
    expect(res.json.visibility).toBe("private"); // forced, even when public was requested
    expect([...res.json.memberIds].sort()).toEqual(["user_b", "user_caller"]);

    const mine = await call(app, "GET", `/chat/channels/${res.json.id}`);
    expect(mine.json.membership.role).toBe("member");
    const theirs = await call(app, "GET", `/chat/channels/${res.json.id}`, { userId: "user_b" });
    expect(theirs.status).toBe(200);
    const stranger = await call(app, "GET", `/chat/channels/${res.json.id}`, { userId: "user_x" });
    expect(stranger.status).toBe(404);
  });

  it("is idempotent per participant set, from either side", async () => {
    const app = createApp(makeDeps());
    const a = await call(app, "POST", "/chat/channels", { body: dm(["user_b"]) });
    const b = await call(app, "POST", "/chat/channels", { body: dm(["user_caller"]), userId: "user_b" });
    expect(b.json.id).toBe(a.json.id);
    const group = await call(app, "POST", "/chat/channels", { body: dm(["user_b", "user_c"]) });
    expect(group.json.id).not.toBe(a.json.id);
  });

  it("lists DMs with memberIds for the participant only", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: dm(["user_b"]) });
    const list = await call(app, "GET", "/chat/channels", { userId: "user_b" });
    const row = list.json.items.find((x: { id: string }) => x.id === c.json.id);
    expect([...row.memberIds].sort()).toEqual(["user_b", "user_caller"]);
    const other = await call(app, "GET", "/chat/channels", { userId: "user_x" });
    expect(other.json.items.some((x: { id: string }) => x.id === c.json.id)).toBe(false);
  });

  it("rejects a DM with nobody else or too many people", async () => {
    const app = createApp(makeDeps());
    expect((await call(app, "POST", "/chat/channels", { body: dm([]) })).status).toBe(400);
    expect((await call(app, "POST", "/chat/channels", { body: dm(["user_caller"]) })).status).toBe(400);
    const nine = Array.from({ length: 9 }, (_, i) => `user_${i}`);
    expect((await call(app, "POST", "/chat/channels", { body: dm(nine) })).status).toBe(400);
  });

  it("DM members cannot be added or removed", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: dm(["user_b"]) });
    const add = await call(app, "POST", `/chat/channels/${c.json.id}/members`, { body: { userId: "user_c" } });
    expect(add.status).toBe(409);
    const leave = await call(app, "DELETE", `/chat/channels/${c.json.id}/members/user_caller`);
    expect(leave.status).toBe(409);
  });

  it("a lost creation race returns the other side's DM instead of failing", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const winner = await call(app, "POST", "/chat/channels", { body: dm(["user_caller"]), userId: "user_b" });
    // Simulate the loser's pre-check running before the winner committed.
    const real = deps.repo.getChannelByDmKey.bind(deps.repo);
    let first = true;
    deps.repo.getChannelByDmKey = async (key: string) => (first ? ((first = false), null) : real(key));
    const loser = await call(app, "POST", "/chat/channels", { body: dm(["user_b"]) });
    expect(loser.json.id).toBe(winner.json.id);
    const list = await call(app, "GET", "/chat/channels");
    expect(list.json.items.filter((c: { type: string }) => c.type === "dm")).toHaveLength(1);
  });

  it("stores a neutral name so neither side sees their own name as the fallback", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "POST", "/chat/channels", { body: dm(["user_b"], { name: "佐藤 花子" }) });
    expect(res.json.name).toBe("DM");
  });

  it("both participants can post", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: dm(["user_b"]) });
    const reply = await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "hi" }, userId: "user_b" });
    expect(reply.status).toBe(201);
  });
});
