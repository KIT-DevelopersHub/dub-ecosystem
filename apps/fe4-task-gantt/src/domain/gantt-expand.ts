// 親タスクの開閉（すべて展開／すべて折りたたむ）と、その状態の保存。並び替え・表示設定
// (gantt-view-pref) と同じく個人の表示設定なので、イベントごとに localStorage へ置く。
import type { common, gantt } from "@dub/types";

/** 開閉トグルを持つ行（子のある親タスク）の id。 */
export function parentIdsOf(rows: readonly gantt.GanttRow[]): common.TaskId[] {
  return rows.filter((r) => r.hasChildren).map((r) => r.taskId);
}

/** 表示中の親が全部開いているか。親が無いときは false（「すべて展開」を出す）。 */
export function allExpanded(
  parentIds: readonly common.TaskId[],
  open: ReadonlySet<common.TaskId>,
): boolean {
  return parentIds.length > 0 && parentIds.every((id) => open.has(id));
}

/** 表示中の親を全部開く。表示外（絞り込みで隠れた親）の開閉は保つ。 */
export function expandAll(
  parentIds: readonly common.TaskId[],
  open: ReadonlySet<common.TaskId>,
): Set<common.TaskId> {
  const next = new Set(open);
  for (const id of parentIds) next.add(id);
  return next;
}

/** 表示中の親を全部閉じる。表示外の親の開閉は保つ。 */
export function collapseAll(
  parentIds: readonly common.TaskId[],
  open: ReadonlySet<common.TaskId>,
): Set<common.TaskId> {
  const next = new Set(open);
  for (const id of parentIds) next.delete(id);
  return next;
}

function storageKey(eventId: common.EventId): string {
  return `fe4:gantt-open-parents:${eventId}`;
}

/** 保存済みの開いている親（無い・壊れている・storage 不可なら空 = 全部閉じた初期表示）。 */
export function loadOpenParents(eventId: common.EventId): Set<common.TaskId> {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(eventId));
    if (raw == null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is common.TaskId => typeof v === "string" && v.length > 0));
  } catch {
    return new Set();
  }
}

export function saveOpenParents(eventId: common.EventId, open: ReadonlySet<common.TaskId>): void {
  try {
    globalThis.localStorage?.setItem(storageKey(eventId), JSON.stringify([...open]));
  } catch {
    /* storage blocked — in-memory state still applies */
  }
}
