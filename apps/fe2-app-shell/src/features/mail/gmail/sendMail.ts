// Delivers a PendingSend through MailApi and reports the outcome to the store, so a
// failure is visible (送信できませんでした + 再試行) and the compose is restored, never lost.
import type { Dispatch } from "react";
import { auth as authRules, type mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { composeWindowDraftKey } from "./ComposeWindow.tsx";
import type { MailAction, PendingSend } from "./useMailStore.tsx";

/** A failure the user can act on; anything else is the bar's plain 送信できませんでした. */
export function failureReason(err: unknown): string | undefined {
  const e = err as { status?: unknown; code?: unknown } | null;
  const status = e?.status;
  // 代理表示中の送信はエッジで意図的に 403 (IMPERSONATION_ACTION_BLOCKED)。権限不足と区別する。
  if (e?.code === "IMPERSONATION_ACTION_BLOCKED") return authRules.IMPERSONATION_BLOCKED_MESSAGE;
  if (status === 413) return "添付ファイルが大きすぎるため送信できませんでした";
  if (status === 403) return "メールを送信する権限がありません";
  return undefined;
}

export async function deliver(api: MailApi, dispatch: Dispatch<MailAction>, pending: PendingSend): Promise<void> {
  dispatch({ type: "SEND_STARTED", pending });
  try {
    if (pending.kind === "schedule") await api.schedule(pending.req as mail.ScheduleMailRequest);
    else await api.send(pending.req, pending.idempotencyKey ? { idempotencyKey: pending.idempotencyKey } : undefined);
  } catch (err) {
    const reason = failureReason(err);
    dispatch({ type: "SEND_FAILED", pending, ...(reason ? { reason } : {}) });
    return;
  }
  // A compose restored by a failure autosaved its draft; drop it so it can't resurrect.
  try {
    globalThis.localStorage?.removeItem(composeWindowDraftKey(pending.compose.id));
  } catch {
    /* storage unavailable */
  }
  dispatch({ type: "SEND_OK", pending });
  // Before the sync below, so its GET /mail/drafts can't bring the sent draft back.
  dispatch({ type: "REMOVE_DRAFT", id: pending.compose.id });
  await pending.draftSettled;
  await api.deleteDraft(pending.compose.id).catch(() => undefined);
  dispatch({ type: "REQUEST_SYNC" });
}
