// Realtime + notification wiring added for Slack-parity:
//   1. postMessage puts the body's `<@id>` mentions (author excluded) on the
//      chat.message.created domain event so notification can raise an in-app
//      notification without ever reading chat D1.
//   2. toggleReaction fans out a `reaction.updated` ChatRealtimeEvent so a reaction
//      shows live on every open client (previously reactions were not realtime).
import { describe, it, expect } from "vitest";
import type { chat } from "@dub/types";
import { makeDeps, call, createApp } from "./harness";

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
