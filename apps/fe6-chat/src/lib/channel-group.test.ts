import { describe, it, expect } from "vitest";
import type { Channel } from "../api/contract";
import { buildSidebar, groupChannels } from "./channel-group";

function chan(id: string, over: Partial<Channel>): Channel {
  return {
    id,
    orgId: "org",
    type: "topic",
    visibility: "public",
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

describe("buildSidebar", () => {
  const sec = (id: string, position: number) => ({ id, name: id, position, createdAt: "t" });

  it("puts assigned channels (any type) in user sections ordered by position, rest in default groups", () => {
    const layout = buildSidebar(
      [
        chan("t1", { type: "topic", name: "b" }),
        chan("t2", { type: "topic", name: "a" }),
        chan("e1", { type: "event", name: "conf" }),
        chan("d1", { type: "dm", name: "dm" }),
      ],
      [sec("later", 2), sec("first", 0)],
      { t1: "first", e1: "first", d1: "later" },
    );
    expect(layout.sections.map((s) => s.section.id)).toEqual(["first", "later"]);
    expect(layout.sections[0]!.channels.map((c) => c.id)).toEqual(["t1", "e1"]); // name sort: b < conf
    expect(layout.sections[1]!.channels.map((c) => c.id)).toEqual(["d1"]);
    expect(layout.groups.map((g) => g.type)).toEqual(["topic"]);
    expect(layout.groups[0]!.channels.map((c) => c.id)).toEqual(["t2"]);
  });

  it("keeps empty sections and falls back to default groups for unknown section ids", () => {
    const layout = buildSidebar([chan("t1", { name: "x" })], [sec("empty", 0)], { t1: "gone" });
    expect(layout.sections).toHaveLength(1);
    expect(layout.sections[0]!.channels).toEqual([]);
    expect(layout.groups[0]!.channels.map((c) => c.id)).toEqual(["t1"]);
  });
});
