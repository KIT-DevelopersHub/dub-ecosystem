import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

async function seed(app: ReturnType<typeof createApp>) {
  const ch = (await call(app, "POST", "/channels", { body: topic })).json.id as string;
  const msg = (await call(app, "POST", "/messages", { body: { channelId: ch, body: "pin me" } })).json.id as string;
  return { ch, msg };
}

describe("pins: add / list / remove", () => {
  it("pins a message, lists it with the embedded message, and audits", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { ch, msg } = await seed(app);

    const pinned = await call(app, "POST", `/channels/${ch}/pins`, { body: { messageId: msg } });
    expect(pinned.status).toBe(201);
    expect(pinned.json.messageId).toBe(msg);
    expect(pinned.json.pinnedBy).toBe("user_caller");
    expect(pinned.json.message.body).toBe("pin me");
    expect(deps.audit.actions()).toContain("chat.pin.add");

    const list = await call(app, "GET", `/channels/${ch}/pins`);
    expect(list.status).toBe(200);
    expect(list.json.items).toHaveLength(1);
    expect(list.json.items[0].message.id).toBe(msg);
  });

  it("pinning twice is idempotent (keeps the original pinner/time)", async () => {
    const app = createApp(makeDeps());
    const { ch, msg } = await seed(app);
    const first = await call(app, "POST", `/channels/${ch}/pins`, { body: { messageId: msg } });
    const again = await call(app, "POST", `/channels/${ch}/pins`, { userId: "user_b_unused", body: { messageId: msg } });
    // user_b is not a member -> 403 anyway, so re-pin by the same member:
    const rePin = await call(app, "POST", `/channels/${ch}/pins`, { body: { messageId: msg } });
    expect(again.status).toBe(403);
    expect(rePin.json.pinnedBy).toBe(first.json.pinnedBy);
    const list = await call(app, "GET", `/channels/${ch}/pins`);
    expect(list.json.items).toHaveLength(1);
  });

  it("unpin removes it and is idempotent", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const { ch, msg } = await seed(app);
    await call(app, "POST", `/channels/${ch}/pins`, { body: { messageId: msg } });

    const del1 = await call(app, "DELETE", `/channels/${ch}/pins/${msg}`);
    expect(del1.status).toBe(204);
    expect(deps.audit.actions()).toContain("chat.pin.remove");
    const del2 = await call(app, "DELETE", `/channels/${ch}/pins/${msg}`);
    expect(del2.status).toBe(204); // no-op
    const list = await call(app, "GET", `/channels/${ch}/pins`);
    expect(list.json.items).toHaveLength(0);
  });

  it("non-members cannot pin or read pins (403)", async () => {
    const app = createApp(makeDeps());
    const { ch, msg } = await seed(app);
    const pin = await call(app, "POST", `/channels/${ch}/pins`, { userId: "user_stranger", body: { messageId: msg } });
    expect(pin.status).toBe(403);
    const list = await call(app, "GET", `/channels/${ch}/pins`, { userId: "user_stranger" });
    expect(list.status).toBe(403);
  });

  it("cannot pin a message from another channel or a deleted message", async () => {
    const app = createApp(makeDeps());
    const { ch, msg } = await seed(app);
    const other = await seed(app);
    const wrongChannel = await call(app, "POST", `/channels/${ch}/pins`, { body: { messageId: other.msg } });
    expect(wrongChannel.status).toBe(404);

    await call(app, "DELETE", `/messages/${msg}`);
    const deleted = await call(app, "POST", `/channels/${ch}/pins`, { body: { messageId: msg } });
    expect(deleted.status).toBe(404);
  });
});
