import { describe, expect, it } from "vitest";
import type { identity } from "@dub/types";
import { calendarCaps } from "./CalendarProvider.tsx";

const holding = (...keys: identity.PermissionKey[]) => (k: identity.PermissionKey) => keys.includes(k);
const ALL: identity.PermissionKey[] = ["calendar:schedule_edit", "task:write", "task:delete"];

describe("calendarCaps (予定の追加/編集/削除)", () => {
  it("allows write + delete with カレンダー編集, 予定を登録, マイタスク編集 and the task keys", () => {
    expect(calendarCaps(true, true, holding(...ALL))).toEqual({ canWrite: true, canDelete: true });
  });

  it("denies write without the 予定を登録 toggle even on a カレンダー編集 role", () => {
    expect(calendarCaps(true, true, holding("task:write", "task:delete"))).toEqual({ canWrite: false, canDelete: false });
  });

  it("caps 予定を登録 at カレンダー閲覧 (no edit tier → no write)", () => {
    expect(calendarCaps(false, true, holding(...ALL)).canWrite).toBe(false);
  });

  it("still needs マイタスク編集 + task:write (予定 are tasks)", () => {
    expect(calendarCaps(true, false, holding(...ALL)).canWrite).toBe(false);
    expect(calendarCaps(true, true, holding("calendar:schedule_edit", "task:delete")).canWrite).toBe(false);
  });

  it("delete additionally needs task:delete", () => {
    expect(calendarCaps(true, true, holding("calendar:schedule_edit", "task:write"))).toEqual({ canWrite: true, canDelete: false });
  });
});
