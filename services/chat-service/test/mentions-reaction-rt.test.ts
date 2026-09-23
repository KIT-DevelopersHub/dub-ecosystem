// Realtime + notification wiring added for Slack-parity:
//   1. postMessage puts the body's `<@id>` mentions (author excluded) on the
//      chat.message.created domain event so notification can raise an in-app
//      notification without ever reading chat D1.
//   2. toggleReaction fans out a `reaction.updated` ChatRealtimeEvent so a reaction
//      shows live on every open client (previously reactions were not realtime).
import { describe, it, expect } from "vitest";
import type { chat } from "@dub/types";
import { makeDeps, call, createApp, FakeMemberClient } from "./harness";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

describe("mentions ride chat.message.created", () => {
  it("carries mentioned userIds (author excluded, de-duped)", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    await call(app, "POST", "/chat/messages", {
      body: { channelId: c.json.id, body: "hey <@user_b> and <@user_c> and <@user_caller> and <@user_b> again" },
    });

    const payloads = deps.publisher.payloadsFor("chat.message.created") as Array<{ mentions?: string[] }>;
    expect(payloads).toHaveLength(1);
    // author (user_caller) filtered out; user_b de-duped.
    expect(payloads[0]!.mentions).toEqual(["user_b", "user_c"]);
  });

  it("omits `mentions` entirely when the body has none (backward-compat no-op)", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "no mentions here" } });

    const payloads = deps.publisher.payloadsFor("chat.message.created") as Array<{ mentions?: string[] }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.mentions).toBeUndefined();
  });
});

describe("DM messages ride chat.message.created with isDm/dmRecipientIds", () => {
  it("carries isDm + the other member's id (author excluded) for a dm-type channel", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", {
      body: { type: "dm", visibility: "private", name: "DM", memberIds: ["user_other"] },
    });
    await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "hi there" } });

    const payloads = deps.publisher.payloadsFor("chat.message.created") as Array<{
      isDm?: boolean;
      dmRecipientIds?: string[];
    }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.isDm).toBe(true);
    expect(payloads[0]!.dmRecipientIds).toEqual(["user_other"]);
  });

  it("omits isDm/dmRecipientIds entirely for a non-dm channel (backward-compat no-op)", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "just a channel message" } });

    const payloads = deps.publisher.payloadsFor("chat.message.created") as Array<{
      isDm?: boolean;
      dmRecipientIds?: string[];
    }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.isDm).toBeUndefined();
    expect(payloads[0]!.dmRecipientIds).toBeUndefined();
  });
});

describe("チーム単位メンション (<!team:id>) は投稿時にチーム員へ展開される", () => {
  it("expands a team mention to its members (author + duplicates excluded)", async () => {
    const memberClient = new FakeMemberClient({
      team_hq: ["user_b", "user_caller"], // 自分も統括所属 -> 自分宛通知はしない
      team_corp: ["user_c", "user_b"],
    });
    const deps = makeDeps({ memberClient });
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    await call(app, "POST", "/chat/messages", {
      body: { channelId: c.json.id, body: "<!team:team_hq> と <!team:team_corp> 確認おねがいします <@user_d>" },
    });

    expect(memberClient.calls).toEqual([["team_hq", "team_corp"]]);
    const payloads = deps.publisher.payloadsFor("chat.message.created") as Array<{ mentions?: string[] }>;
    expect(payloads[0]!.mentions).toEqual(["user_d", "user_b", "user_c"]);
  });

  it("never calls member-service when the body has no team mention", async () => {
    const memberClient = new FakeMemberClient({ team_hq: ["user_b"] });
    const deps = makeDeps({ memberClient });
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "hi <@user_b>" } });
    expect(memberClient.calls).toEqual([]);
  });

  it("does NOT notify for a mention written inside code (documentation, not a ping)", async () => {
    const memberClient = new FakeMemberClient({ team_hq: ["user_b"] });
    const deps = makeDeps({ memberClient });
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    await call(app, "POST", "/chat/messages", {
      // インラインコードと、行頭から始まる ``` フェンス (レンダラと同じ判定単位)。
      body: { channelId: c.json.id, body: "書き方はこう: `<!team:team_hq>`\n```\n<@user_c>\n```" },
    });
    expect(memberClient.calls).toEqual([]);
    const payloads = deps.publisher.payloadsFor("chat.message.created") as Array<{ mentions?: string[] }>;
    expect(payloads[0]!.mentions).toBeUndefined();
  });

  it("on a PRIVATE channel, team members who are not in the channel are not notified", async () => {
    const memberClient = new FakeMemberClient({ team_hq: ["user_in", "user_out"] });
    const deps = makeDeps({ memberClient });
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", {
      body: { type: "topic", visibility: "private", name: "Secret" },
    });
    await call(app, "POST", `/chat/channels/${c.json.id}/members`, { body: { userId: "user_in" } });
    await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "<!team:team_hq> 内緒の話" } });

    const payloads = deps.publisher.payloadsFor("chat.message.created") as Array<{ mentions?: string[] }>;
    expect(payloads[0]!.mentions).toEqual(["user_in"]);
  });

  it("still posts when the team has no linked accounts (no mentions on the event)", async () => {
    const deps = makeDeps({ memberClient: new FakeMemberClient({}) });
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const m = await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "<!team:team_hq> hi" } });
    expect(m.status).toBe(201);
    const payloads = deps.publisher.payloadsFor("chat.message.created") as Array<{ mentions?: string[] }>;
    expect(payloads[0]!.mentions).toBeUndefined();
  });
});

describe("reaction.updated realtime fan-out", () => {
  it("publishes reaction.updated with the full post-toggle set on add and remove", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const m = await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "react to me" } });

    await call(app, "POST", `/chat/messages/${m.json.id}/reactions`, { body: { emoji: "👍" } });
    await call(app, "POST", `/chat/messages/${m.json.id}/reactions`, { body: { emoji: "👍" } });

    const rt = deps.realtime.events
      .map((e) => e.event)
      .filter((e): e is Extract<chat.ChatRealtimeEvent, { kind: "reaction.updated" }> => e.kind === "reaction.updated");
    expect(rt).toHaveLength(2);

    // add: full set includes the caller under 👍
    expect(rt[0]!.op).toBe("added");
    expect(rt[0]!.emoji).toBe("👍");
    expect(rt[0]!.messageId).toBe(m.json.id);
    expect(rt[0]!.reactions["👍"]).toEqual(["user_caller"]);

    // remove: op flips and the emoji is gone from the authoritative set
    expect(rt[1]!.op).toBe("removed");
    expect(rt[1]!.reactions["👍"]).toBeUndefined();
  });
});
