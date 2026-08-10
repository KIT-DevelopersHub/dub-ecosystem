import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

describe("threads: replyCount surfaced on the root message", () => {
  it("counts visible replies on the root; replies themselves are 0; deleted replies drop out", async () => {
    const app = createApp(makeDeps());
    const ch = (await call(app, "POST", "/channels", { body: topic })).json.id;
    const root = (await call(app, "POST", "/messages", { body: { channelId: ch, body: "root" } })).json.id;
    const r1 = (await call(app, "POST", "/messages", { body: { channelId: ch, body: "r1", threadRootId: root } })).json.id;
    await call(app, "POST", "/messages", { body: { channelId: ch, body: "r2", threadRootId: root } });

    let list = await call(app, "GET", "/messages", { query: { channelId: ch } });
    const rootView = list.json.items.find((m: any) => m.id === root);
    const replyView = list.json.items.find((m: any) => m.id === r1);
    expect(rootView.replyCount).toBe(2);
    expect(replyView.replyCount).toBe(0);

    // deleting a reply lowers the count
    await call(app, "DELETE", `/messages/${r1}`);
    list = await call(app, "GET", "/messages", { query: { channelId: ch } });
    expect(list.json.items.find((m: any) => m.id === root).replyCount).toBe(1);
  });
});

describe("mark-unread: rewind the read cursor", () => {
  async function channelWithOthersMessages() {
    const app = createApp(makeDeps());
    const ch = (await call(app, "POST", "/channels", { body: topic })).json.id;
    await call(app, "POST", `/channels/${ch}/members`, { body: { userId: "user_b" } });
    const ids: string[] = [];
    for (const body of ["a", "b", "c"]) {
      ids.push((await call(app, "POST", "/messages", { userId: "user_b", body: { channelId: ch, body } })).json.id);
    }
    return { app, ch, ids };
  }

  it("marking unread from a message makes it (and later ones) unread again", async () => {
    const { app, ch, ids } = await channelWithOthersMessages();
    // caller reads to the latest -> 0 unread
    await call(app, "POST", `/channels/${ch}/read`, { body: { lastReadMessageId: ids[2] } });

    const res = await call(app, "POST", `/channels/${ch}/mark-unread`, { body: { messageId: ids[1] } });
    expect(res.status).toBe(200);
    expect(res.json.lastReadMessageId).toBe(ids[0]); // cursor rewound to just before ids[1]
    expect(res.json.unreadCount).toBe(2); // ids[1], ids[2]
  });

  it("marking unread from the first message clears the cursor (everything unread)", async () => {
    const { app, ch, ids } = await channelWithOthersMessages();
    await call(app, "POST", `/channels/${ch}/read`, { body: { lastReadMessageId: ids[2] } });

    const res = await call(app, "POST", `/channels/${ch}/mark-unread`, { body: { messageId: ids[0] } });
    expect(res.json.lastReadMessageId).toBeNull();
    expect(res.json.unreadCount).toBe(3);
  });

  it("rejects a message that is not in the channel", async () => {
    const { app, ch } = await channelWithOthersMessages();
    const res = await call(app, "POST", `/channels/${ch}/mark-unread`, { body: { messageId: "msg_elsewhere" } });
    expect(res.status).toBe(400);
  });
});

describe("join: self-join a public channel", () => {
  it("a non-member joins a public channel and becomes a member (idempotent); emits member.added", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const ch = (await call(app, "POST", "/channels", { body: topic })).json.id;

    const join = await call(app, "POST", `/channels/${ch}/join`, { userId: "user_joiner" });
    expect(join.status).toBe(200);
    expect(join.json.membership.role).toBe("member");
    expect(deps.publisher.payloadsFor("chat.member.added")).toContainEqual({ channelId: ch, userId: "user_joiner", change: "added" });
    expect(deps.realtime.kinds()).toContain("member.added");

    // now a member -> can post
    const post = await call(app, "POST", "/messages", { userId: "user_joiner", body: { channelId: ch, body: "hi" } });
    expect(post.status).toBe(201);

    // second join is a no-op
    const again = await call(app, "POST", `/channels/${ch}/join`, { userId: "user_joiner" });
    expect(again.status).toBe(200);
    expect(deps.publisher.namesFor("chat.member.added")).toHaveLength(1);
  });

  it("cannot self-join a private channel (hidden -> 404)", async () => {
    const app = createApp(makeDeps());
    const priv = (await call(app, "POST", "/channels", { body: { ...topic, visibility: "private" } })).json.id;
    const res = await call(app, "POST", `/channels/${priv}/join`, { userId: "user_stranger" });
    expect(res.status).toBe(404);
  });

  it("cannot join an archived channel (409)", async () => {
    const app = createApp(makeDeps());
    const ch = (await call(app, "POST", "/channels", { body: topic })).json.id;
    await call(app, "PATCH", `/channels/${ch}`, { body: { version: 1, archived: true } });
    const res = await call(app, "POST", `/channels/${ch}/join`, { userId: "user_joiner" });
    expect(res.status).toBe(409);
  });
});
