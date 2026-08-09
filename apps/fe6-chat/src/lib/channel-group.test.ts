import { describe, it, expect } from "vitest";
import type { Channel } from "../api/contract";
import { groupChannels } from "./channel-group";

function chan(id: string, over: Partial<Channel>): Channel {
  return {
    id,
    orgId: "org",
    type: "topic",
    name: id,
    topic: null,
    eventId: null,
    archived: false,
    memberCount: 1,
    version: 1,
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

describe("groupChannels", () => {
  it("groups by type in topic/event/dm order, omitting empty groups", () => {
    const groups = groupChannels([chan("a", { type: "event", name: "a" }), chan("b", { type: "topic", name: "b" })]);
    expect(groups.map((g) => g.type)).toEqual(["topic", "event"]);
  });

  it("sinks archived channels to the bottom of their group", () => {
    const groups = groupChannels([
      chan("z", { type: "topic", name: "zulu", archived: true }),
      chan("a", { type: "topic", name: "alpha" }),
    ]);
    expect(groups[0]!.channels.map((c) => c.name)).toEqual(["alpha", "zulu"]);
  });
});
