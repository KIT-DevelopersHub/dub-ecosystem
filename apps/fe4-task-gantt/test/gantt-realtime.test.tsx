import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { gantt } from "@dub/types";
import { avatarColor, avatarInitials, presenceLabel } from "../src/realtime/presence";
import { GanttRtClient } from "../src/realtime/gantt-rt-client";
import { PresenceBar } from "../src/components/PresenceBar";

describe("presence avatar helpers", () => {
  it("avatarColor is deterministic and stable per user", () => {
    expect(avatarColor("usr_1")).toBe(avatarColor("usr_1"));
    expect(avatarColor("usr_1")).not.toBe(avatarColor("usr_2"));
    expect(avatarColor("usr_1")).toMatch(/^hsl\(/);
  });
  it("avatarInitials handles Latin words, single Latin word, and CJK surnames", () => {
    expect(avatarInitials("Ann Lee")).toBe("AL");
    expect(avatarInitials("ann")).toBe("AN");
    expect(avatarInitials("高岡 己太朗")).toBe("高");
    expect(avatarInitials("")).toBe("?");
  });
  it("presenceLabel prefers the signed name, then roster, then id", () => {
    const roster = new Map([["u2", "Ben"]]);
    expect(presenceLabel({ userId: "u1", displayName: "Ann", editing: false, editingTaskIds: [] }, roster)).toBe("Ann");
    expect(presenceLabel({ userId: "u2", editing: false, editingTaskIds: [] }, roster)).toBe("Ben");
    expect(presenceLabel({ userId: "u3", editing: false, editingTaskIds: [] }, roster)).toBe("u3");
  });
});

describe("PresenceBar", () => {
  const roster = new Map<string, string>([["u1", "Ann"], ["u2", "Ben"]]);
  const users: gantt.GanttPresenceUser[] = [
    { userId: "u1", displayName: "Ann", editing: false, editingTaskIds: [] },
    { userId: "u2", displayName: "Ben", editing: true, editingTaskIds: ["t1"] },
  ];

  it("renders an avatar per user, marks editing, and puts self first", () => {
    render(<PresenceBar presence={users} status="open" selfUserId={"u2"} displayNameById={roster} />);
    expect(screen.getByTestId("fe4-presence-avatar-u1")).toBeInTheDocument();
    const ben = screen.getByTestId("fe4-presence-avatar-u2");
    expect(ben).toHaveAttribute("data-editing", "true");
    // self (u2) sorts before u1
    const avatars = screen.getAllByRole("listitem");
    expect(avatars[0]).toHaveAttribute("data-testid", "fe4-presence-avatar-u2");
    expect(screen.getByText(/1人が編集中/)).toBeInTheDocument();
  });

  it("opens a roster popover listing every viewer with the self tag", () => {
    render(<PresenceBar presence={users} status="open" selfUserId={"u1"} displayNameById={roster} />);
    // Closed by default: no roster menu yet.
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /このガントを見ているメンバー/ }));
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    // Both names are listed, and the local user is tagged （あなた）.
    expect(screen.getByRole("menuitem", { name: /Ann/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Ben/ })).toBeInTheDocument();
    expect(screen.getByText(/（あなた）/)).toBeInTheDocument();
    // Editing viewer (Ben) is surfaced as 編集中 in the list.
    expect(screen.getAllByText("編集中").length).toBeGreaterThan(0);
  });

  it("collapses overflow into +N", () => {
    const many: gantt.GanttPresenceUser[] = Array.from({ length: 8 }, (_, i) => ({
      userId: `u${i}`,
      editing: false,
      editingTaskIds: [],
    }));
    render(<PresenceBar presence={many} status="open" selfUserId={null} displayNameById={new Map()} max={5} />);
    expect(screen.getByText("+3")).toBeInTheDocument();
  });
});

// Minimal fake WebSocket to drive the client without a real socket.
class FakeWS {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("GanttRtClient", () => {
  function setup() {
    let fake: FakeWS | null = null;
    const timers: Array<() => void> = [];
    const client = new GanttRtClient({
      getTicket: async () => ({
        ticket: "tk",
        doUrl: "wss://rt.example/ws/evt_1",
        expiresAt: new Date().toISOString() as gantt.WsTicketResponse["expiresAt"],
        self: { userId: "u1" },
      }),
      wsFactory: (url) => {
        expect(url).toContain("ticket=tk");
        fake = new FakeWS();
        return fake as unknown as WebSocket;
      },
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length as unknown as number;
      },
      clearTimer: () => {},
    });
    return { client, getFake: () => fake!, timers };
  }

  it("sends hello + starts heartbeat on open, and parses presence/data events", async () => {
    const { client, getFake } = setup();
    const events: gantt.GanttRealtimeEvent[] = [];
    client.onEvent((e) => events.push(e));
    client.connect();
    await flush();
    getFake().open();
    expect(getFake().sent).toContain(JSON.stringify({ t: "hello" }));

    getFake().emit("pong"); // ignored
    getFake().emit(JSON.stringify({ kind: "presence", users: [] }));
    getFake().emit(JSON.stringify({ kind: "data.changed", change: "schedule", actorId: "u2", at: "now" }));
    expect(events.map((e) => e.kind)).toEqual(["presence", "data.changed"]);
  });

  it("forwards intent frames (state / change) once open", async () => {
    const { client, getFake } = setup();
    client.connect();
    await flush();
    getFake().open();
    client.setEditing(true, "t7");
    client.notifyChange("task.deleted", "t7");
    expect(getFake().sent).toContain(JSON.stringify({ t: "state", editing: true, editingTaskId: "t7" }));
    expect(getFake().sent).toContain(JSON.stringify({ t: "change", change: "task.deleted", taskId: "t7" }));
  });

  it("reports status open→reconnecting on drop and schedules a reconnect", async () => {
    const { client, getFake, timers } = setup();
    const statuses: string[] = [];
    client.onStatusChange((s) => statuses.push(s));
    client.connect();
    await flush();
    getFake().open();
    expect(client.getStatus()).toBe("open");
    getFake().close();
    expect(client.getStatus()).toBe("reconnecting");
    expect(timers.length).toBeGreaterThan(0); // a reconnect timer was scheduled
  });
});
