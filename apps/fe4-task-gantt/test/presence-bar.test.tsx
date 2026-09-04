import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { common, gantt } from "@dub/types";
import { PresenceBar } from "../src/components/PresenceBar";

const names = new Map<common.UserId, string>([
  ["user_self", "私"],
  ["user_a", "Ada Lovelace"],
  ["user_b", "山田 太郎"],
]);

function bar(
  presence: gantt.GanttPresenceUser[],
  status: "open" | "connecting" = "open",
  max?: number,
  selfUserId: common.UserId | null = "user_self" as common.UserId,
) {
  return render(
    <PresenceBar
      presence={presence}
      status={status}
      selfUserId={selfUserId}
      displayNameById={names}
      max={max}
    />,
  );
}

describe("PresenceBar", () => {
  it("shows ALL viewers as avatars, INCLUDING the local user (自分含む全員)", () => {
    bar([{ userId: "user_self" }, { userId: "user_a" }, { userId: "user_b" }]);
    expect(screen.getByTestId("fe4-presence-bar")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-presence-avatar-user_self")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-presence-avatar-user_a")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-presence-avatar-user_b")).toBeInTheDocument();
    // self is badged "（あなた）"
    expect(screen.getByTestId("fe4-presence-avatar-user_self")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("（あなた）"),
    );
    expect(screen.getByText("3 人が閲覧中")).toBeInTheDocument();
  });

  it("injects self so a single tab still sees itself (1タブでも自分が出る)", () => {
    // The frame carries no one (or hasn't arrived) yet — self is still shown when connected.
    bar([]);
    expect(screen.getByTestId("fe4-presence-avatar-user_self")).toBeInTheDocument();
    expect(screen.getByText("1 人が閲覧中")).toBeInTheDocument();
  });

  it("dedupes a user that appears twice (multi-tab ⇒ one avatar)", () => {
    bar([{ userId: "user_a" }, { userId: "user_a" }], "open", undefined, null);
    expect(screen.getAllByTestId("fe4-presence-avatar-user_a")).toHaveLength(1);
    expect(screen.getByText("1 人が閲覧中")).toBeInTheDocument();
  });

  it("collapses overflow into a +N chip", () => {
    bar(
      [
        { userId: "user_a" },
        { userId: "user_b" },
        { userId: "user_c" },
        { userId: "user_d" },
      ],
      "open",
      2,
      null, // no self injection so the count is purely the four peers
    );
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("uses the roster label's initials for the avatar", () => {
    bar([{ userId: "user_b" }], "open", undefined, null); // 山田 太郎 → 山
    expect(screen.getByTestId("fe4-presence-avatar-user_b")).toHaveTextContent("山");
  });
});
