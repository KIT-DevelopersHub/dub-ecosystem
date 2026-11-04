// 「Googleと連携」 (ダッシュボードの「定例に参加」) comes back to /driveshare — the one return page the
// Web OAuth client accepts — with a state starting meeting.GOOGLE_LINK_STATE_PREFIX. This finishes
// it (stores the member's Google account id) and returns to the dashboard. Renders nothing.
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { meeting } from "@dub/types";
import { useDriveShareApi } from "./DriveShareProvider.tsx";

const handled = new Set<string>();

/** Back to the dashboard (a full load: this page is entered from Google, nothing to keep). */
function toDashboard(): void {
  window.setTimeout(() => window.location.assign("/"), 1200);
}

export function GoogleLinkReturn({ onDone = toDashboard }: { onDone?: () => void }): null {
  const api = useDriveShareApi();
  const toast = useToast();
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const state = q.get("state");
    if (!state?.startsWith(meeting.GOOGLE_LINK_STATE_PREFIX) || handled.has(state)) return;
    handled.add(state);
    window.history.replaceState(window.history.state, "", window.location.pathname);
    const code = q.get("code");
    const done = onDone;
    if (!code) {
      toast.show({ kind: "info", title: "Google との連携をキャンセルしました" });
      done();
      return;
    }
    api
      .completeGoogleLink(code, state)
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["home", "my-regular-meetings"] });
        toast.show({ kind: "success", title: "Google と連携しました。Meet に入るだけで定例の出席になります" });
      })
      .catch(() => toast.show({ kind: "error", title: "Google と連携できませんでした。もう一度お試しください" }))
      .finally(done);
  }, [api, onDone, toast, qc]);
  return null;
}
