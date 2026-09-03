import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { common, gantt } from "@dub/types";
import { PresenceBar } from "../src/components/PresenceBar";

const names = new Map<common.UserId, string>([
  ["user_self", "私"],
  ["user_a", "Ada Lovelace"],
  ["user_b", "山田 太郎"],
]);

function bar(presence: gantt.GanttPresenceUser[], status: "open" | "connecting" = "open", max?: number) {
  return render(
    <PresenceBar
      presence={presence}
      status={status}
      selfUserId={"user_self" as common.UserId}
      displayNameById={names}
      max={max}
    />,
  );
}

describe("PresenceBar", () => {
  it("shows OTHER viewers as avatars and excludes the local user (自分以外)", () => {
    bar([{ userId: "user_self" }, { userId: "user_a" }, { userId: "user_b" }]);
    expect(screen.getByTestId("fe4-presence-bar")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-presence-avatar-user_a")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-presence-avatar-user_b")).toBeInTheDocument();
    // self is filtered out
    expect(screen.queryByTestId("fe4-presence-avatar-user_self")).toBeNull();
    expect(screen.getByText("他 2 人が閲覧中")).toBeInTheDocument();
  });

  it("dedupes a user that appears twice", () => {
    bar([{ userId: "user_a" }, { userId: "user_a" }]);
    expect(screen.getAllByTestId("fe4-presence-avatar-user_a")).toHaveLength(1);
    expect(screen.getByText("他 1 人が閲覧中")).toBeInTheDocument();
  });

  it("renders nothing when only the local user is present and connected", () => {
    const { container } = bar([{ userId: "user_self" }]);
    expect(container.firstChild).toBeNull();
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
    );
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("uses the roster label's initials for the avatar", () => {
    bar([{ userId: "user_b" }]); // 山田 太郎 → 山
    expect(screen.getByTestId("fe4-presence-avatar-user_b")).toHaveTextContent("山");
  });
});
