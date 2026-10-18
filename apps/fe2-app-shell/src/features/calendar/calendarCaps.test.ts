import { describe, expect, it } from "vitest";
import type { identity } from "@dub/types";
import { calendarCaps } from "./CalendarProvider.tsx";

const holding = (...keys: identity.PermissionKey[]) => (k: identity.PermissionKey) => keys.includes(k);

describe("calendarCaps (予定の追加/編集/削除)", () => {
  it("allows write + delete with カレンダー編集, 予定を登録 and task:delete", () => {
    expect(calendarCaps(true, holding("calendar:schedule_edit", "task:delete"))).toEqual({ canWrite: true, canDelete: true });
  });

  it("denies write without the 予定を登録 toggle even on a カレンダー編集 role", () => {
    expect(calendarCaps(true, holding("task:write", "task:delete"))).toEqual({ canWrite: false, canDelete: false });
  });

  it("caps 予定を登録 at カレンダー閲覧 (no edit tier → no write)", () => {
    expect(calendarCaps(false, holding("calendar:schedule_edit", "task:delete")).canWrite).toBe(false);
  });

  it("needs no マイタスク key: 予定を登録 alone opens 予定の追加 on a カレンダー編集 role", () => {
    expect(calendarCaps(true, holding("calendar:schedule_edit"))).toEqual({ canWrite: true, canDelete: false });
  });
});
