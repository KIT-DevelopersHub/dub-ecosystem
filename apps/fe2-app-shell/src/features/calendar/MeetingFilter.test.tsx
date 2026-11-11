import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { meeting } from "@dub/types";
import { MeetingFilter, googleCalendarAddUrl } from "./MeetingFilter.tsx";

const TARGETS: meeting.MeetingTarget[] = [
  { id: "all", name: "全体", memberCount: 9, isMine: true, calendarId: "c_all@group.calendar.google.com" },
  { id: "role_lead", name: "統括", memberCount: 2, isMine: true },
  { id: "role_member", name: "member", memberCount: 4, isMine: false },
];

describe("MeetingFilter 「Googleカレンダーに追加」", () => {
  it("builds Google's add-calendar link with the base64 calendar id (no padding)", () => {
    expect(googleCalendarAddUrl("c_all@group.calendar.google.com")).toBe(
      "https://calendar.google.com/calendar/u/0/r?cid=Y19hbGxAZ3JvdXAuY2FsZW5kYXIuZ29vZ2xlLmNvbQ",
    );
  });

  it("shows the link only on calendars that carry an id, and opens it in a new tab", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<MeetingFilter targets={TARGETS} visible={new Set(["all"])} loading={false} onChange={() => undefined} />);
    expect(screen.queryByTestId("calendar-meeting-add-google-role_lead")).toBeNull();
    expect(screen.queryByTestId("calendar-meeting-add-google-role_member")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "「全体」のカレンダーをGoogleカレンダーに追加" }));
    expect(open).toHaveBeenCalledWith(googleCalendarAddUrl("c_all@group.calendar.google.com"), "_blank", "noopener,noreferrer");
    open.mockRestore();
  });
});
