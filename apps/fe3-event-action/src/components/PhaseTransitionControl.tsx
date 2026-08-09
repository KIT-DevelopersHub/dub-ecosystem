import { useState } from "react";
import type { event } from "@dub/types";
import { Button } from "@dub/ui";
import { classifyError, normalizeError } from "../lib/errorMap";
import { phaseTransitionOptions } from "../lib/phase";
import { phaseLabel } from "./PhaseBadge";
import { useUpdateEvent } from "../hooks/useEventMutations";
import { ConfirmDialog } from "./ConfirmDialog";
import styles from "./components.module.css";

export function PhaseTransitionControl({
  event: ev,
  permissions,
}: {
  event: event.DubEvent;
  permissions: { write: boolean; admin: boolean };
}) {
  const update = useUpdateEvent(ev.id);
  const [pendingClosed, setPendingClosed] = useState<event.EventPhase | null>(null);
  const options = phaseTransitionOptions(ev.phase, permissions);

  const transition = (to: event.EventPhase) => {
    update.mutate({ version: ev.version, phase: to });
  };

  const phaseError =
    update.isError && classifyError(normalizeError(update.error).code) === "phase-error"
      ? normalizeError(update.error).message
      : null;

  return (
    <div className={styles.phaseControl} data-testid="fe3-detail-phase-control">
      {options.map((opt) => (
        <Button
          key={opt.to}
          variant={opt.dangerous ? "danger" : "secondary"}
          disabled={!opt.enabled}
          onClick={() => (opt.dangerous ? setPendingClosed(opt.to) : transition(opt.to))}
          testId={`fe3-detail-phase-${opt.to}`}
        >
          → {phaseLabel(opt.to)}
        </Button>
      ))}
      {phaseError ? <div className={styles.errorText}>{phaseError}</div> : null}
      <ConfirmDialog
        open={pendingClosed !== null}
        title="イベントを終了しますか？"
        message="終了フェーズへ移行すると再開できません。よろしいですか？"
        confirmLabel="終了する"
        onConfirm={() => {
          if (pendingClosed) transition(pendingClosed);
          setPendingClosed(null);
        }}
        onCancel={() => setPendingClosed(null)}
        testId="fe3-detail-phase-confirm"
      />
    </div>
  );
}
