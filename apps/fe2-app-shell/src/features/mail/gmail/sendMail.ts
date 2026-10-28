// Delivers a PendingSend through MailApi and reports the outcome to the store, so a
// failure is visible (送信できませんでした + 再試行) and the compose is restored, never lost.
import type { Dispatch } from "react";
import type { mail } from "@dub/types";
import type { MailApi } from "../mailApi.tsx";
import { composeWindowDraftKey } from "./ComposeWindow.tsx";
import type { MailAction, PendingSend } from "./useMailStore.tsx";

export async function deliver(api: MailApi, dispatch: Dispatch<MailAction>, pending: PendingSend): Promise<void> {
  dispatch({ type: "SEND_STARTED", pending });
  try {
    if (pending.kind === "schedule") await api.schedule(pending.req as mail.ScheduleMailRequest);
    else await api.send(pending.req);
  } catch {
    dispatch({ type: "SEND_FAILED", pending });
    return;
  }
  // A compose restored by a failure autosaved its draft; drop it so it can't resurrect.
  try {
    globalThis.localStorage?.removeItem(composeWindowDraftKey(pending.compose.id));
  } catch {
    /* storage unavailable */
  }
  dispatch({ type: "SEND_OK", pending });
  dispatch({ type: "REQUEST_SYNC" });
}
