// 「Googleと連携」 (ダッシュボードの「定例に参加」) comes back to /driveshare — the one return page the
// Web OAuth client accepts — with a state starting meeting.GOOGLE_LINK_STATE_PREFIX. Mounted in the
// shell (not the Drive共有 screen: a member's role may not open Drive共有), it finishes the link
// (stores the member's Google account id) and returns to the dashboard. Renders nothing; on every
// other URL it does nothing at all (no hooks beyond reading the address).
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { meeting } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { completeGoogleLink } from "../lib/meet-join.ts";
import { MY_REGULARS_KEY } from "./screens/dashboard/RegularMeetingsCard.tsx";

const handled = new Set<string>();

/** Back to the dashboard (a full load: this page is entered from Google, nothing to keep). */
function toDashboard(): void {
  window.setTimeout(() => window.location.assign("/"), 1200);
}

function linkReturn(): { code: string | null; state: string } | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const state = q.get("state");
  return state?.startsWith(meeting.GOOGLE_LINK_STATE_PREFIX) ? { code: q.get("code"), state } : null;
}

export function GoogleLinkReturn({ api, onDone = toDashboard }: { api: ApiClient; onDone?: () => void }): JSX.Element | null {
  const [ret] = useState(linkReturn);
  return ret ? <Finish api={api} ret={ret} onDone={onDone} /> : null;
}

function Finish({ api, ret, onDone }: { api: ApiClient; ret: { code: string | null; state: string }; onDone: () => void }): null {
  const toast = useToast();
  const qc = useQueryClient();
  useEffect(() => {
    if (handled.has(ret.state)) return;
    handled.add(ret.state);
    window.history.replaceState(window.history.state, "", window.location.pathname);
    if (!ret.code) {
      toast.show({ kind: "info", title: "Google との連携をキャンセルしました" });
      onDone();
      return;
    }
    completeGoogleLink(api, ret.code, ret.state)
      .then(() => {
        void qc.invalidateQueries({ queryKey: MY_REGULARS_KEY });
        toast.show({ kind: "success", title: "Google と連携しました。Meet に入るだけで定例の出席になります" });
      })
      .catch(() => toast.show({ kind: "error", title: "Google と連携できませんでした。もう一度お試しください" }))
      .finally(onDone);
  }, [api, ret, onDone, toast, qc]);
  return null;
}
