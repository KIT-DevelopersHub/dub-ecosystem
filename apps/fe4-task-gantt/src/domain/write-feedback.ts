// Shared write-operation feedback (the "3点セット" contract, see docs/FRONTEND_GUIDE.md
// 「書き込み操作の楽観的UI」). Every write UI in fe4 pairs an optimistic cache update
// with:
//   1. success  → a success toast ("保存しました" 等)
//   2. failure  → a mapped, human-readable error toast (never a swallowed catch)
// plus a caller-owned rollback of the optimistic change. Centralizing the toast copy
// + error mapping here keeps the behaviour identical across create/edit/delete/
// reorder/dependency actions and makes it the natural default for new edit UIs.
import { useMemo } from "react";
import { useToast } from "@dub/ui";
import { toDisplayableError } from "../contracts/spa-shell";
import { mapError } from "./error-mapping";

export interface WriteFeedback {
  /** Show a success toast (auto-dismiss). Default copy: 「保存しました」. */
  success: (message?: string) => void;
  /** Map any thrown value to a human-readable error toast (sticky until dismissed).
   *  Returns the mapped message so callers can log/annotate if needed. */
  failure: (error: unknown, fallback?: string) => string;
}

export function useWriteFeedback(): WriteFeedback {
  const toast = useToast();
  return useMemo<WriteFeedback>(
    () => ({
      success: (message = "保存しました") => toast.show({ kind: "success", title: message }),
      failure: (error, fallback) => {
        const ux = mapError(toDisplayableError(error));
        const title = ux.message || fallback || "保存に失敗しました";
        toast.show({ kind: "error", title });
        return title;
      },
    }),
    [toast],
  );
}
