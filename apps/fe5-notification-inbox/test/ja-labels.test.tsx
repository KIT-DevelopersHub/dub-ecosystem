// #857: the inbox, launcher entry and bell must be in Japanese like the rest of the UI.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { screen } from "@testing-library/react";
import { NotificationInboxPage } from "../src/components/NotificationInboxPage";
import notificationsModule from "../src/module";
import { makeDeps, renderWithDeps } from "./helpers";

describe("Japanese UI labels (#857)", () => {
  it("inbox header, mark-all button and unread filter are Japanese", async () => {
    const { deps } = makeDeps();
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, category: "all", type: "" }} />, deps);
    await screen.findByTestId("fe5-inbox-list");
    expect(screen.getByTestId("fe5-inbox-header")).toHaveTextContent("通知");
    expect(screen.getByTestId("fe5-inbox-markall")).toHaveTextContent("すべて既読にする");
    expect(screen.getByText("未読のみ")).toBeInTheDocument();
  });

  it("launcher nav label is 通知", () => {
    expect(notificationsModule.nav?.[0]?.label).toBe("通知");
  });

  it("no leftover English UI strings in components", () => {
    const dir = join(__dirname, "../src/components");
    const banned = /["'>`]\s*(Notifications|Mark all as read|Unread only|Save changes|Notification settings|Retry)\s*["'<`]/;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(banned);
    }
  });
});
