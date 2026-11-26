// Display-side authorization gating. The server (authz/check) is the true
// authority; FE4 only reflects `effectivePermissions` (from GET /api/v1/me) to
// enable/disable UI (design §6). fail-closed while permissions are unloaded.
import { task } from "@dub/types";
import type { common, identity } from "@dub/types";

type PermissionKey = identity.PermissionKey;

export interface TaskCapabilities {
  canRead: boolean;
  canWrite: boolean; // create / edit / D&D / dependency edit
  canDelete: boolean;
}

/** `perms === null` == not yet loaded -> everything denied (fail-closed). */
export function taskCapabilities(perms: readonly PermissionKey[] | null): TaskCapabilities {
  if (perms === null) return { canRead: false, canWrite: false, canDelete: false };
  const has = (k: PermissionKey): boolean => perms.includes(k);
  return {
    canRead: has("task:read"),
    canWrite: has("task:write"),
    canDelete: has("task:delete"),
  };
}

/** The hint a read-only task shows (detail panel + bar tooltip). */
export const READ_ONLY_TASK_HINT =
  "担当者と依頼者だけが編集できます（担当がチームならそのチームのメンバー、担当がいなければ作成者）。すべて編集するにはロール管理の「すべてのタスクを編集」が必要です";

/**
 * Per-task edit check for the UI (#881), mirroring task-service via `task.canEditTask`.
 * Unknown ids are read-only (fail-closed) except optimistic `task_tmp_*` rows, which the
 * caller just created. `currentUserId === null` (not loaded) ⇒ only `task:edit_all` edits.
 * `myTeamIds`: teams I belong to (members of a task's 担当チーム edit it).
 */
export function makeCanEditTask(
  tasks: readonly task.Task[],
  currentUserId: common.UserId | null,
  perms: readonly PermissionKey[] | null,
  myTeamIds: readonly common.TeamId[] = [],
): (id: common.TaskId) => boolean {
  if (perms === null || !perms.includes("task:write")) return () => false;
  const holdsEditAll = perms.includes(task.TASK_EDIT_ALL_KEY);
  if (holdsEditAll) return () => true;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return (id) => {
    if (id.startsWith("task_tmp_")) return true;
    const t = byId.get(id);
    if (!t || currentUserId === null) return false;
    return task.canEditTask(t, { userId: currentUserId, teamIds: myTeamIds }, false);
  };
}

/**
 * A gantt BAR moves/resizes its whole subtree (a parent's drag writes its descendants), so it
 * is draggable only when the task and every descendant are editable.
 */
export function makeCanEditBar(
  canEditTask: (id: common.TaskId) => boolean,
  rows: readonly { taskId: common.TaskId; parentTaskId?: common.TaskId | null }[],
): (id: common.TaskId) => boolean {
  const children = new Map<common.TaskId, common.TaskId[]>();
  for (const r of rows) {
    if (!r.parentTaskId) continue;
    const list = children.get(r.parentTaskId) ?? [];
    list.push(r.taskId);
    children.set(r.parentTaskId, list);
  }
  return (id) => {
    const stack = [id];
    const seen = new Set<common.TaskId>();
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (!canEditTask(cur)) return false;
      stack.push(...(children.get(cur) ?? []));
    }
    return true;
  };
}
