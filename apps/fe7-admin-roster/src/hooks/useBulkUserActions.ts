// ① テーブル一括選択アクション — apply one action to every SELECTED roster row.
// The identity contract has no batch endpoint, so we fan out the existing per-user
// calls (PATCH status / POST role) and reconcile with Promise.allSettled: partial
// failure is reported truthfully (「N件成功 / M件失敗」) instead of an all-or-nothing lie.
// NON-optimistic (destructive / confirmed upstream): we invalidate the list after.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { common, identity } from "@dub/types";
import { useRosterContext } from "../providers/RosterProvider";
import { useToast } from "./useToast";
import { ADMIN_QK } from "../lib/queryKeys";
import { presentError } from "../lib/errorDisplay";

/** Partial key matching EVERY cached roster list query (all filter/cursor/sort variants). */
const USERS_KEY = [ADMIN_QK, "users"] as const;

export interface BulkOutcome {
  ok: number;
  failed: number;
}

/** Fan a per-user async action across `ids`, tallying success/failure. */
async function runBulk(ids: readonly string[], op: (id: string) => Promise<unknown>): Promise<BulkOutcome> {
  const results = await Promise.allSettled(ids.map((id) => op(id)));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  return { ok, failed: results.length - ok };
}

function toastOutcome(
  toast: ReturnType<typeof useToast>["toast"],
  outcome: BulkOutcome,
  verb: string,
): void {
  if (outcome.failed === 0) {
    toast({ kind: "success", title: `${outcome.ok}件を${verb}しました` });
  } else if (outcome.ok === 0) {
    toast({ kind: "error", title: `${verb}に失敗しました`, description: `${outcome.failed}件すべて失敗しました` });
  } else {
    toast({ kind: "warning", title: `一部のみ${verb}しました`, description: `成功 ${outcome.ok}件 / 失敗 ${outcome.failed}件` });
  }
}

/** Bulk set status (利用停止 / 在籍に戻す) for the selected users. */
export function useBulkSetStatus() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<BulkOutcome, unknown, { ids: readonly common.UserId[]; status: identity.UserStatus; verb: string }>({
    mutationFn: ({ ids, status }) => runBulk(ids, (id) => api.patchUser(id, { status })),
    onSuccess: (outcome, { verb }) => toastOutcome(toast, outcome, verb),
    onError: (err) => {
      const p = presentError(err);
      toast({ kind: "error", title: "一括操作に失敗しました", description: "message" in p ? p.message : undefined });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

/** Bulk grant an org-wide role (ロール付与) to the selected users. Users who already hold
 *  the role reject with CONFLICT server-side; those count as "failed" but the rest apply. */
export function useBulkAssignRole() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<BulkOutcome, unknown, { ids: readonly common.UserId[]; roleId: common.RoleId; roleName: string }>({
    mutationFn: ({ ids, roleId }) => runBulk(ids, (id) => api.assignRole(id, { roleId })),
    onSuccess: (outcome, { roleName }) => toastOutcome(toast, outcome, `「${roleName}」を付与`),
    onError: (err) => {
      const p = presentError(err);
      toast({ kind: "error", title: "一括付与に失敗しました", description: "message" in p ? p.message : undefined });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: USERS_KEY }),
  });
}
